/**
 * accessory.ts — HomeKit Switch accessory wrapping the SolarChargeController.
 *
 * This class ties the Homebridge accessory lifecycle to the core controller:
 *   Switch ON  → controller.start()  — begins polling Sense + adjusting Tesla amps
 *   Switch OFF → controller.stop()   — halts polling; Sense WebSocket stays alive
 *
 * State persistence:
 *   `accessory.context.isActive` is written on every toggle and survives
 *   Homebridge restarts. On construction, if `isActive` is true, the controller
 *   is restarted automatically so charging optimisation resumes without user action.
 *
 * Auto-off feature (optional):
 *   When `homebridge.auto_off_after_no_solar_minutes` is configured, a separate
 *   `setInterval` monitor runs alongside the controller. Every polling interval it
 *   reads the latest Sense solar watts. If solar stays at zero longer than the
 *   configured threshold, the switch is flipped OFF programmatically and the
 *   change is pushed to HomeKit (so the UI updates without user interaction).
 *   The timer resets whenever solar production resumes.
 *
 * Error paths:
 *   - Controller errors (Tesla API failures, Sense stale data, wake timeout)
 *     → handled inside the controller; emitted as 'log' events which are routed
 *       to the Homebridge logger here. The switch stays ON — the controller keeps
 *       retrying each poll cycle.
 *   - Auto-off monitor timer fires but controller is already stopped
 *     → `stopController()` is idempotent; double-stop is safe.
 *   - Homebridge restarts with switch ON and Sense connection failing
 *     → controller is started (switch restored to ON), but poll ticks will log
 *       "Poll tick failed" until Sense reconnects. No crash.
 */

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { SolarChargeController } from '@homebridge-ev-solar-charger/core';
import { EvSolarChargerPlatform } from './platform.js';

/**
 * Persisted shape stored in `accessory.context`.
 * Homebridge serialises this to disk, so it survives restarts.
 */
interface AccessoryContext {
  device: { uniqueId: string; displayName: string };
  /** Whether solar-optimised charging was active when Homebridge last shut down. */
  isActive: boolean;
}

/**
 * EvSolarChargerAccessory
 *
 * Exposes a single HomeKit Switch that controls the SolarChargeController:
 *   ON  → controller.start() — begins polling Sense and adjusting Tesla charge amps
 *   OFF → controller.stop()  — halts polling; Sense WebSocket stays alive
 *
 * State is written to `accessory.context.isActive` on every toggle so that
 * the next Homebridge launch can restore the correct switch position and
 * restart the controller automatically if it was active.
 *
 * Auto-off: when `homebridge.auto_off_after_no_solar_minutes` is set, a
 * monitor runs alongside the controller and flips the switch OFF automatically
 * once solar production has been zero for the configured duration.
 */
export class EvSolarChargerAccessory {
  private readonly service: Service;
  private readonly controller: SolarChargeController;

  /** Timestamp (ms) when solar production first dropped to zero. Null if solar is present. */
  private noSolarSince: number | null = null;

  /** Handle returned by setInterval for the auto-off monitor. Null when inactive. */
  private autoOffTimer: ReturnType<typeof setInterval> | null = null;

  /** Resolved once at construction; null means the feature is disabled. */
  private readonly autoOffMinutes: number | null;

  constructor(
    private readonly platform: EvSolarChargerPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // ---- Auto-off config ------------------------------------------------------

    this.autoOffMinutes =
      this.platform.appConfig.homebridge?.auto_off_after_no_solar_minutes ?? null;

    // ---- Controller -----------------------------------------------------------

    this.controller = new SolarChargeController(
      platform.appConfig,
      platform.sense,
      platform.tesla,
    );

    // Route every controller event through the Homebridge logger.
    this.controller.on('log', (level, msg) =>
      this.platform.log[level](`[Controller] ${msg}`));

    this.controller.on('charging:start', (amps) =>
      this.platform.log.info(`Charging started at ${amps}A`));

    this.controller.on('charging:stop', () =>
      this.platform.log.info('Charging stopped'));

    this.controller.on('amps:adjust', (from, to) =>
      this.platform.log.info(`Amps adjusted: ${from}A → ${to}A`));

    // ---- Accessory Information service ----------------------------------------

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'homebridge-ev-solar-charger')
      .setCharacteristic(this.platform.Characteristic.Model, 'EV Solar Charger Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.UUID);

    // ---- Switch service -------------------------------------------------------

    this.service =
      this.accessory.getService(this.platform.Service.Switch) ??
      this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.context.device?.displayName ?? 'EV Solar Charger',
    );

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));

    // ---- Restore cached state -------------------------------------------------
    // If the switch was ON before the last shutdown, restart the controller so
    // charging optimisation resumes without the user having to toggle it again.

    if (this.context.isActive === true) {
      this.platform.log.info(
        `[${this.context.device?.displayName}] Restoring active state from cache`,
      );
      this.startController();
    }

    // Push the definitive running state to HomeKit so its UI matches reality.
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(this.controller.isRunning());
  }

  // ---- Characteristic handlers -----------------------------------------------

  /**
   * HomeKit polls this to display the current switch position.
   * We derive the answer directly from the controller — no separate flag needed.
   */
  async handleOnGet(): Promise<CharacteristicValue> {
    const running = this.controller.isRunning();
    this.platform.log.debug(
      `[${this.context.device?.displayName}] GET On → ${running}`,
    );
    return running;
  }

  /**
   * HomeKit calls this when the user flips the switch.
   * start() / stop() are synchronous, so state is stable before we persist.
   */
  async handleOnSet(value: CharacteristicValue): Promise<void> {
    const enable = value as boolean;

    if (enable) {
      this.startController();
    } else {
      this.stopController();
    }

    this.platform.log.info(
      `[${this.context.device?.displayName}] Solar charge optimisation ${
        this.context.isActive ? 'started' : 'stopped'
      }`,
    );
  }

  // ---- Controller lifecycle --------------------------------------------------

  /**
   * Start the controller and, when configured, the auto-off solar monitor.
   * All paths that turn the switch ON must go through here.
   */
  private startController(): void {
    this.controller.start();
    this.context.isActive = true;
    this.startAutoOffMonitor();
  }

  /**
   * Stop the controller and the auto-off monitor.
   * All paths that turn the switch OFF must go through here.
   */
  private stopController(): void {
    this.controller.stop();
    this.context.isActive = false;
    this.stopAutoOffMonitor();
  }

  // ---- Auto-off monitor ------------------------------------------------------

  /**
   * Begin watching solar production. Runs a tick every `poll_interval_seconds`.
   * No-ops when auto_off_after_no_solar_minutes is null (feature disabled).
   */
  private startAutoOffMonitor(): void {
    if (this.autoOffMinutes === null) return;
    if (this.autoOffTimer !== null) return; // already running

    const intervalMs = this.platform.appConfig.charging.poll_interval_seconds * 1_000;
    this.noSolarSince = null;

    this.autoOffTimer = setInterval(() => this.checkAutoOff(), intervalMs);

    this.platform.log.debug(
      `[${this.context.device?.displayName}] Auto-off monitor started ` +
      `(threshold: ${this.autoOffMinutes} min, check interval: ${intervalMs / 1_000}s)`,
    );
  }

  /**
   * Stop the auto-off monitor and reset its state.
   */
  private stopAutoOffMonitor(): void {
    if (this.autoOffTimer !== null) {
      clearInterval(this.autoOffTimer);
      this.autoOffTimer = null;
    }
    this.noSolarSince = null;
  }

  /**
   * Called on each monitor tick. Checks the latest Sense solar reading and
   * fires auto-off once the zero-solar window exceeds the configured threshold.
   */
  private checkAutoOff(): void {
    const solarWatts = this.platform.sense.getSolarWatts();

    if (solarWatts > 0) {
      // Solar is back — reset the window.
      if (this.noSolarSince !== null) {
        this.platform.log.debug(
          `[${this.context.device?.displayName}] Solar resumed (${solarWatts}W) — auto-off timer reset`,
        );
        this.noSolarSince = null;
      }
      return;
    }

    // Solar is at zero.
    if (this.noSolarSince === null) {
      this.noSolarSince = Date.now();
      this.platform.log.debug(
        `[${this.context.device?.displayName}] Solar dropped to zero — auto-off timer started`,
      );
      return;
    }

    const elapsedMinutes = (Date.now() - this.noSolarSince) / 60_000;

    if (elapsedMinutes >= this.autoOffMinutes!) {
      this.platform.log.info(
        `[${this.context.device?.displayName}] No solar for ${elapsedMinutes.toFixed(1)} min ` +
        `(threshold: ${this.autoOffMinutes} min) — auto-off triggered`,
      );
      this.triggerAutoOff();
    }
  }

  /**
   * Flip the switch OFF programmatically (auto-off triggered, not user-driven).
   * Stops the controller, clears the monitor, and pushes the new state to HomeKit.
   */
  private triggerAutoOff(): void {
    this.stopController(); // also clears the monitor timer
    // Push the OFF state to HomeKit so the UI updates without a user interaction.
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(false);
  }

  // ---- Helpers ---------------------------------------------------------------

  /** Typed accessor for the persisted context object. */
  private get context(): AccessoryContext {
    return this.accessory.context as AccessoryContext;
  }
}
