import { EventEmitter } from 'events';
import { AppConfig } from './config.js';
import { SenseClient } from './sense.js';
import { TeslaClient, Vehicle } from './tesla.js';

/** Single-phase EV charger voltage assumed by the Owner's API. */
const VOLTS = 240;

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

  /** Cached after the first successful Tesla API call. */
  private vehicle: Vehicle | null = null;

  /**
   * Whether we believe the car is currently charging.
   * Tracks commands issued by this controller, not live vehicle state.
   */
  private charging = false;

  /**
   * Last amp setpoint commanded to the car.
   * Used to subtract the car's own draw from the Sense home reading so the
   * surplus calculation is based on non-car home load only.
   */
  private currentAmps = 0;

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
    this.log('info', 'Controller started');
    this.schedulePoll(0);
  }

  /** Stop the polling loop. Does not command the car to stop charging. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
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
        if (this.running) {
          this.schedulePoll(this.config.charging.poll_interval_seconds * 1_000);
        }
      });
    }, delayMs);
  }

  // ---- Poll tick -------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      if (!this.vehicle) {
        this.vehicle = await this.tesla.getVehicle(this.config.tesla.vin);
        this.log('info', `Using vehicle: ${this.vehicle.display_name} (${this.vehicle.vin})`);
      }

      const solarW = this.sense.getSolarWatts();
      const homeW = this.sense.getHomeWatts();

      // Sense homeW includes the car's own charging load. Subtract it to get
      // the base house load, then compute what solar can actually provide the car.
      const baseLoadW = homeW - this.currentAmps * VOLTS;
      const availableW = solarW - baseLoadW;
      const rawAmps = availableW / VOLTS;

      this.log(
        'info',
        `Solar ${solarW}W · Home ${homeW}W · Available ${availableW.toFixed(0)}W · Raw target ${rawAmps.toFixed(1)}A`,
      );

      if (!this.charging) {
        if (rawAmps >= this.config.charging.min_amps) {
          const targetAmps = clamp(rawAmps, this.config.charging.min_amps, this.config.charging.max_amps);
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
          const targetAmps = clamp(rawAmps, this.config.charging.min_amps, this.config.charging.max_amps);
          if (targetAmps !== this.currentAmps) {
            await this.cmdAdjustAmps(targetAmps);
          } else {
            this.log('info', `Charging steady at ${this.currentAmps}A — no change`);
          }
        }
      }
    } catch (err) {
      this.log('error', `Poll tick failed: ${(err as Error).message}`);
    }
  }

  // ---- Car commands ----------------------------------------------------------

  private async cmdStartCharging(amps: number): Promise<void> {
    const { id, display_name } = this.vehicle!;
    this.log('info', `Waking ${display_name}…`);
    await this.tesla.wakeVehicle(id);
    await this.tesla.setChargingAmps(id, amps);
    await this.tesla.startCharging(id);
    this.currentAmps = amps;
    this.charging = true;
    this.log('info', `Charging started at ${amps}A`);
    this.emit('charging:start', amps);
  }

  private async cmdStopCharging(reason: string): Promise<void> {
    const { id } = this.vehicle!;
    await this.tesla.stopCharging(id);
    this.currentAmps = 0;
    this.charging = false;
    this.log('info', `Charging stopped (${reason})`);
    this.emit('charging:stop');
  }

  private async cmdAdjustAmps(targetAmps: number): Promise<void> {
    const { id } = this.vehicle!;
    const prev = this.currentAmps;
    await this.tesla.setChargingAmps(id, targetAmps);
    this.currentAmps = targetAmps;
    this.log('info', `Amps adjusted ${prev}A → ${targetAmps}A`);
    this.emit('amps:adjust', prev, targetAmps);
  }

  // ---- Helpers ---------------------------------------------------------------

  private log(level: LogLevel, message: string): void {
    this.emit('log', level, message);
  }
}

/**
 * Floor `value` then clamp to [min, max].
 * Flooring avoids requesting more amps than available solar can cover.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
