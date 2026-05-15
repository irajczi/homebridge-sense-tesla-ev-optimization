/**
 * controller.ts — Solar charge controller: the core decision-making loop.
 *
 * `SolarChargeController` polls the Sense client for current solar and home
 * watts on a configurable interval and issues Tesla charging commands to keep
 * the car consuming only surplus solar energy.
 *
 * Surplus calculation (per poll tick):
 *   The PRD spec uses raw Sense home watts directly. This implementation takes
 *   a more precise approach: it subtracts the car's own current/last-commanded
 *   draw from the Sense home reading before computing surplus. This matters
 *   because Sense usually includes the car's charger as part of total home
 *   consumption — subtracting it lets us calculate the true base house load and
 *   therefore the correct target amps for the car.
 *
 *   If Sense does NOT detect the car as a separate device, this subtraction
 *   over-corrects by zero until charging begins, so the result is still correct
 *   on the first start. On startup, the controller also checks live Tesla charge
 *   state; if the car is already pulling power, that draw seeds the in-memory
 *   car-load estimate before the first Sense calculation.
 *
 * Scheduling:
 *   Uses a chained `setTimeout` rather than `setInterval` so ticks never
 *   overlap: the next poll is only scheduled after the current tick resolves
 *   (or rejects). This prevents pile-up if a Tesla API call is slow.
 *
 * Event model:
 *   The controller emits typed events (`log`, `charging:start`, `charging:stop`,
 *   `amps:adjust`) rather than logging directly. Callers (CLI, Homebridge plugin)
 *   wire these to their own loggers so the core has zero output-format coupling.
 *
 * Error paths:
 *   - Any error inside `tick()` (Sense stale, Tesla API, wake timeout, etc.)
 *     → caught, emitted as `log('error', 'Poll tick failed: …')`, and the
 *       next poll is still scheduled. The process does NOT crash.
 *   - Vehicle fetch failure (first tick only)
 *     → same error path; `this.vehicle` stays null and is retried next tick.
 *   - Stop/start command failure
 *     → thrown from the Tesla client, caught by the tick catch block,
 *       and `this.charging` / `this.currentAmps` are NOT updated (so the next
 *       tick will try the same command again rather than assuming it succeeded).
 */

import { EventEmitter } from 'events';
import { AppConfig } from './config.js';
import { isWithinHomeRadius, nextLocalClockTime, nextSunriseWake } from './location.js';
import { SenseClient } from './sense.js';
import { TeslaClient, Vehicle, VehicleChargeStatus } from './tesla.js';

/** Single-phase EV charger voltage assumed by the Owner's API. */
const VOLTS = 240;
const DEFAULT_ADAPTIVE_STABLE_AFTER_MINUTES = 2;
const DEFAULT_ADAPTIVE_STABLE_INTERVAL_SECONDS = 300;
const DEFAULT_ADAPTIVE_CHANGE_THRESHOLD_WATTS = 250;

export type LogLevel = 'info' | 'warn' | 'error';

// ---- Typed event overloads --------------------------------------------------
// These let callers write controller.on('log', (level, msg) => …) without casts.

export interface SolarChargeController {
  emit(event: 'log', level: LogLevel, message: string): boolean;
  emit(event: 'charging:start', amps: number): boolean;
  emit(event: 'charging:stop'): boolean;
  emit(event: 'amps:adjust', from: number, to: number): boolean;

  on(event: 'log', listener: (level: LogLevel, message: string) => void): this;
  on(event: 'charging:start', listener: (amps: number) => void): this;
  on(event: 'charging:stop', listener: () => void): this;
  on(event: 'amps:adjust', listener: (from: number, to: number) => void): this;
}

// ---- Controller -------------------------------------------------------------

export class SolarChargeController extends EventEmitter {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private expensivePowerTimer: ReturnType<typeof setTimeout> | null = null;
  private insufficientSolarSince: number | null = null;
  private awaitingDailyWake = false;
  private nextPollDelayMs: number | null = null;
  private lastPollSample: PollSample | null = null;
  private stableSince: number | null = null;
  private adaptiveBackoffActive = false;
  private startupChargeStateSynced = false;

  /** Cached after the first successful Tesla API call. */
  private vehicle: Vehicle | null = null;

  /**
   * Whether we believe the car is currently charging.
   * Seeded from live vehicle state on startup, then tracks controller commands.
   */
  private charging = false;

  /**
   * Last known active/current amp setpoint for the car. On controller startup,
   * this can come from live Tesla charge state if something else already
   * started the session.
   */
  private currentAmps = 0;

  /**
   * Last known car charging draw. This is subtracted from the Sense home
   * reading so surplus math is based on non-car home load only.
   */
  private currentChargeWatts = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly sense: SenseClient,
    private readonly tesla: TeslaClient,
  ) {
    super();
  }

  /** Begin polling. Safe to call multiple times — no-ops if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.isDailyWakeMode()) {
      this.log('info', 'Controller started in daily wake mode');
      this.scheduleNextDailyWake();
    } else {
      this.log('info', 'Controller started');
      this.scheduleExpensivePowerCutoff();
      this.schedulePoll(0);
    }
  }

  /** Stop the polling loop. Does not command the car to stop charging. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.expensivePowerTimer !== null) {
      clearTimeout(this.expensivePowerTimer);
      this.expensivePowerTimer = null;
    }
    this.insufficientSolarSince = null;
    this.awaitingDailyWake = false;
    this.nextPollDelayMs = null;
    this.lastPollSample = null;
    this.stableSince = null;
    this.adaptiveBackoffActive = false;
    this.startupChargeStateSynced = false;
    this.log('info', 'Controller stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---- Scheduling ------------------------------------------------------------

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      // Use .finally so the next poll is always scheduled even after an error,
      // and sequential (no overlapping ticks).
      this.tick().finally(() => {
        if (this.running && !this.awaitingDailyWake) {
          this.schedulePoll(this.nextPollDelayMs ?? this.config.charging.poll_interval_seconds * 1_000);
        }
      });
    }, delayMs);
  }

  private scheduleNextDailyWake(): void {
    if (!this.running) return;

    const { home, automation } = this.config;
    if (home?.latitude === undefined || home.longitude === undefined || !home.timezone || !automation) {
      this.log('error', 'Daily wake mode requires home latitude, longitude, and timezone');
      return;
    }

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.expensivePowerTimer !== null) {
      clearTimeout(this.expensivePowerTimer);
      this.expensivePowerTimer = null;
    }
    this.insufficientSolarSince = null;
    this.resetAdaptivePolling();
    this.awaitingDailyWake = true;

    const wakeAt = nextSunriseWake(
      new Date(),
      home.latitude,
      home.longitude,
      home.timezone,
      automation.wake_after_sunrise_minutes,
    );
    const delayMs = Math.max(0, wakeAt.getTime() - Date.now());

    this.log('info', `Next car check scheduled for ${wakeAt.toLocaleString('en-US', { timeZone: home.timezone })} (${home.timezone})`);

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.dailyWakeCheck().catch((err: unknown) => {
        this.log('error', `Daily wake check failed: ${(err as Error).message}`);
        this.scheduleNextDailyWake();
      });
    }, delayMs);
  }

  private async dailyWakeCheck(): Promise<void> {
    if (!this.running) return;

    if (!this.vehicle) {
      this.vehicle = await this.tesla.getVehicle(this.config.tesla.vin);
      this.log('info', `Using vehicle: ${this.vehicle.display_name} (${this.vehicle.vin})`);
    }

    this.log('info', `Daily check: waking ${this.vehicle.display_name}`);
    await this.tesla.wakeVehicle(this.vehicle.id);
    const status = await this.tesla.getVehicleStatus(this.vehicle.id);

    if (status.charge.isComplete) {
      this.log('info', 'Daily check skipped: vehicle charge is complete');
      this.scheduleNextDailyWake();
      return;
    }

    if (!status.charge.isPluggedIn) {
      this.log('info', `Daily check skipped: vehicle is not plugged in (${status.charge.chargingState})`);
      this.scheduleNextDailyWake();
      return;
    }

    if (this.config.home?.latitude !== undefined && this.config.home.longitude !== undefined) {
      if (!status.location) {
        this.log('warn', 'Daily check skipped: Tesla did not return vehicle location');
        this.scheduleNextDailyWake();
        return;
      }

      const homeCheck = isWithinHomeRadius(status.location, this.config.home);
      if (!homeCheck.atHome) {
        this.log(
          'info',
          `Daily check skipped: vehicle is ${homeCheck.distanceMeters.toFixed(0)}m from home ` +
          `(radius ${homeCheck.radiusMeters}m)`,
        );
        this.scheduleNextDailyWake();
        return;
      }

      this.log('info', `Daily check passed: vehicle is plugged in at home (${homeCheck.distanceMeters.toFixed(0)}m away)`);
    }

    this.startupChargeStateSynced = true;
    this.applyLiveChargeStatus(status.charge);

    this.awaitingDailyWake = false;
    this.scheduleExpensivePowerCutoff();
    this.schedulePoll(0);
  }

  private scheduleExpensivePowerCutoff(): void {
    if (!this.running) return;
    if (this.expensivePowerTimer !== null) {
      clearTimeout(this.expensivePowerTimer);
      this.expensivePowerTimer = null;
    }

    const clockTime = this.config.automation?.power_expensive_start_time?.trim();
    if (!clockTime) return;

    const timeZone = this.config.home?.timezone;
    if (!timeZone) {
      this.log('warn', 'Power-expensive cutoff configured but home.timezone is missing');
      return;
    }

    const cutoffAt = nextLocalClockTime(new Date(), timeZone, clockTime);
    const delayMs = Math.max(0, cutoffAt.getTime() - Date.now());
    this.log('info', `Power-expensive cutoff scheduled for ${cutoffAt.toLocaleString('en-US', { timeZone })} (${timeZone})`);

    this.expensivePowerTimer = setTimeout(() => {
      this.expensivePowerTimer = null;
      this.handleExpensivePowerCutoff().catch((err: unknown) => {
        this.log('error', `Power-expensive cutoff failed: ${(err as Error).message}`);
        this.scheduleExpensivePowerCutoff();
      });
    }, delayMs);
  }

  private async handleExpensivePowerCutoff(): Promise<void> {
    if (!this.running) return;

    const clockTime = this.config.automation?.power_expensive_start_time?.trim();
    this.log('info', `Power-expensive cutoff reached${clockTime ? ` (${clockTime})` : ''} — stopping charging`);

    if (this.charging) {
      await this.cmdStopCharging('power-expensive cutoff reached');
    }

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.resetAdaptivePolling();

    if (this.isDailyWakeMode()) {
      this.scheduleNextDailyWake();
    } else {
      this.awaitingDailyWake = true;
      this.log('info', 'Controller paused after power-expensive cutoff; turn it off/on to resume before tomorrow');
    }
  }

  // ---- Poll tick -------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      if (!this.vehicle) {
        this.vehicle = await this.tesla.getVehicle(this.config.tesla.vin);
        this.log('info', `Using vehicle: ${this.vehicle.display_name} (${this.vehicle.vin})`);
      }

      await this.syncStartupChargeState();

      const solarW = this.sense.getSolarWatts();
      const homeW = this.sense.getHomeWatts();

      // Sense homeW includes the car's own charging load. Subtract it to get
      // the base house load, then compute what solar can actually provide the car.
      const baseLoadW = Math.max(0, homeW - this.currentChargeWatts);
      const availableW = solarW - baseLoadW;
      const rawAmps = availableW / VOLTS;
      const targetAmps = rawAmps >= this.config.charging.min_amps
        ? clamp(rawAmps, this.config.charging.min_amps, this.config.charging.max_amps)
        : 0;

      this.log(
        'info',
        `Solar ${solarW}W · Home ${homeW}W · Tesla ${this.currentChargeWatts.toFixed(0)}W · ` +
        `Available ${availableW.toFixed(0)}W · Raw target ${rawAmps.toFixed(1)}A`,
      );

      this.updateAdaptivePolling({
        solarW,
        homeW,
        targetAmps,
        chargeable: rawAmps >= this.config.charging.min_amps,
      });

      const shouldSleepAfterInsufficient = await this.trackInsufficientSolar(rawAmps);
      if (shouldSleepAfterInsufficient) {
        return;
      }

      if (!this.charging) {
        if (rawAmps >= this.config.charging.min_amps) {
          await this.cmdStartCharging(targetAmps);
        } else {
          this.log(
            'info',
            `Surplus ${rawAmps.toFixed(1)}A below minimum ${this.config.charging.min_amps}A — not starting`,
          );
        }
      } else {
        if (this.config.charging.stop_when_insufficient && rawAmps < this.config.charging.min_amps) {
          await this.cmdStopCharging(`surplus dropped to ${rawAmps.toFixed(1)}A`);
        } else {
          const commandTargetAmps = clamp(rawAmps, this.config.charging.min_amps, this.config.charging.max_amps);
          if (commandTargetAmps !== this.currentAmps) {
            await this.cmdAdjustAmps(commandTargetAmps);
          } else {
            this.log('info', `Charging steady at ${this.currentAmps}A — no change`);
          }
        }
      }
    } catch (err) {
      this.log('error', `Poll tick failed: ${(err as Error).message}`);
    }
  }

  private async trackInsufficientSolar(rawAmps: number): Promise<boolean> {
    const sleepAfterMinutes = this.config.automation?.sleep_after_insufficient_minutes ?? null;
    if (!this.isDailyWakeMode() || sleepAfterMinutes === null) {
      return false;
    }

    if (rawAmps >= this.config.charging.min_amps) {
      if (this.insufficientSolarSince !== null) {
        this.log('info', 'Solar surplus recovered — insufficient-solar timer reset');
      }
      this.insufficientSolarSince = null;
      return false;
    }

    if (this.insufficientSolarSince === null) {
      this.insufficientSolarSince = Date.now();
      this.log(
        'info',
        `Solar surplus below minimum — will sleep for the day if it stays low for ${sleepAfterMinutes} min`,
      );
      return false;
    }

    const elapsedMinutes = (Date.now() - this.insufficientSolarSince) / 60_000;
    if (elapsedMinutes < sleepAfterMinutes) {
      return false;
    }

    this.log(
      'info',
      `Solar surplus stayed below minimum for ${elapsedMinutes.toFixed(1)} min — sleeping until next daily check`,
    );

    if (this.charging) {
      await this.cmdStopCharging('sleeping after prolonged insufficient solar');
    }
    if (this.expensivePowerTimer !== null) {
      clearTimeout(this.expensivePowerTimer);
      this.expensivePowerTimer = null;
    }
    this.scheduleNextDailyWake();
    return true;
  }

  private updateAdaptivePolling(sample: PollSample): void {
    const settings = this.getAdaptivePollingSettings();
    if (!settings.enabled) {
      this.nextPollDelayMs = this.config.charging.poll_interval_seconds * 1_000;
      return;
    }

    const now = Date.now();
    const changed = this.hasMeaningfulChange(sample, settings.changeThresholdWatts);
    this.lastPollSample = sample;

    if (changed) {
      this.stableSince = null;
      this.nextPollDelayMs = this.config.charging.poll_interval_seconds * 1_000;
      if (this.adaptiveBackoffActive) {
        this.log('info', 'Adaptive polling: change detected — returning to normal interval');
        this.adaptiveBackoffActive = false;
      }
      return;
    }

    this.stableSince ??= now;
    const stableMinutes = (now - this.stableSince) / 60_000;
    const shouldBackOff = stableMinutes >= settings.stableAfterMinutes;

    if (shouldBackOff) {
      this.nextPollDelayMs = settings.stableIntervalSeconds * 1_000;
      if (!this.adaptiveBackoffActive) {
        this.log(
          'info',
          `Adaptive polling: readings stable for ${stableMinutes.toFixed(1)} min — backing off to ` +
          `${settings.stableIntervalSeconds}s checks`,
        );
        this.adaptiveBackoffActive = true;
      }
    } else {
      this.nextPollDelayMs = this.config.charging.poll_interval_seconds * 1_000;
    }
  }

  private hasMeaningfulChange(sample: PollSample, thresholdWatts: number): boolean {
    if (this.lastPollSample === null) return true;
    return Math.abs(sample.solarW - this.lastPollSample.solarW) > thresholdWatts ||
      Math.abs(sample.homeW - this.lastPollSample.homeW) > thresholdWatts ||
      sample.targetAmps !== this.lastPollSample.targetAmps ||
      sample.chargeable !== this.lastPollSample.chargeable;
  }

  private resetAdaptivePolling(): void {
    this.nextPollDelayMs = null;
    this.lastPollSample = null;
    this.stableSince = null;
    this.adaptiveBackoffActive = false;
  }

  private getAdaptivePollingSettings(): AdaptivePollingSettings {
    const configured = this.config.charging.adaptive_polling;
    return {
      enabled: configured?.enabled === true,
      stableAfterMinutes: configured?.stable_after_minutes ?? DEFAULT_ADAPTIVE_STABLE_AFTER_MINUTES,
      stableIntervalSeconds: configured?.stable_interval_seconds ?? DEFAULT_ADAPTIVE_STABLE_INTERVAL_SECONDS,
      changeThresholdWatts: configured?.change_threshold_watts ?? DEFAULT_ADAPTIVE_CHANGE_THRESHOLD_WATTS,
    };
  }

  // ---- Car commands ----------------------------------------------------------

  private async cmdStartCharging(amps: number): Promise<void> {
    const { id, display_name } = this.vehicle!;
    this.log('info', `Waking ${display_name}…`);
    await this.tesla.wakeVehicle(id);
    await this.tesla.setChargingAmps(id, amps);
    await this.tesla.startCharging(id);
    this.currentAmps = amps;
    this.currentChargeWatts = amps * VOLTS;
    this.charging = true;
    this.log('info', `Charging started at ${amps}A`);
    this.emit('charging:start', amps);
  }

  private async cmdStopCharging(reason: string): Promise<void> {
    const { id } = this.vehicle!;
    await this.tesla.stopCharging(id);
    this.currentAmps = 0;
    this.currentChargeWatts = 0;
    this.charging = false;
    this.log('info', `Charging stopped (${reason})`);
    this.emit('charging:stop');
  }

  private async cmdAdjustAmps(targetAmps: number): Promise<void> {
    const { id } = this.vehicle!;
    const prev = this.currentAmps;
    await this.tesla.setChargingAmps(id, targetAmps);
    this.currentAmps = targetAmps;
    this.currentChargeWatts = targetAmps * VOLTS;
    this.log('info', `Amps adjusted ${prev}A → ${targetAmps}A`);
    this.emit('amps:adjust', prev, targetAmps);
  }

  // ---- Helpers ---------------------------------------------------------------

  private log(level: LogLevel, message: string): void {
    this.emit('log', level, message);
  }

  private isDailyWakeMode(): boolean {
    return this.config.automation?.daily_wake_enabled === true;
  }

  private async syncStartupChargeState(): Promise<void> {
    if (this.startupChargeStateSynced) return;
    this.startupChargeStateSynced = true;

    const vehicle = this.vehicle;
    if (!vehicle) return;

    if (vehicle.state !== 'online') {
      this.log('info', `Startup charge-state check skipped: vehicle is ${vehicle.state}`);
      return;
    }

    try {
      const status = await this.tesla.getVehicleStatus(vehicle.id);
      this.applyLiveChargeStatus(status.charge);
    } catch (err) {
      this.log('warn', `Startup charge-state check failed: ${(err as Error).message}`);
    }
  }

  private applyLiveChargeStatus(charge: VehicleChargeStatus): void {
    const voltage = charge.chargerVoltage && charge.chargerVoltage > 0 ? charge.chargerVoltage : VOLTS;
    const reportedAmps = charge.actualAmps ?? charge.requestedAmps;
    const liveAmps = reportedAmps ?? (charge.chargerPowerWatts !== null ? charge.chargerPowerWatts / voltage : 0);
    const liveWatts = reportedAmps !== null && reportedAmps > 0
      ? reportedAmps * voltage
      : charge.chargerPowerWatts ?? 0;
    const isDrawingPower = liveWatts > 0 || liveAmps > 0;
    const isCharging = charge.chargingState === 'Charging' || isDrawingPower;

    if (!isCharging) {
      this.log('info', `Startup charge-state check: vehicle is ${charge.chargingState}; Tesla load baseline is 0W`);
      return;
    }

    this.currentAmps = Math.round(liveAmps);
    this.currentChargeWatts = liveWatts;
    this.charging = true;
    this.log(
      'info',
      `Startup charge-state check: vehicle already charging at ${liveAmps.toFixed(1)}A ` +
      `(${liveWatts.toFixed(0)}W); using that as the Tesla load baseline`,
    );
  }
}

/**
 * Floor `value` then clamp to [min, max].
 * Flooring avoids requesting more amps than available solar can cover.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

interface PollSample {
  solarW: number;
  homeW: number;
  targetAmps: number;
  chargeable: boolean;
}

interface AdaptivePollingSettings {
  enabled: boolean;
  stableAfterMinutes: number;
  stableIntervalSeconds: number;
  changeThresholdWatts: number;
}
