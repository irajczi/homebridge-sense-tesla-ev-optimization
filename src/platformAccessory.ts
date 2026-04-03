import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { EvSolarChargerPlatform } from './platform.js';

/**
 * EvSolarChargerAccessory
 *
 * Represents the EV Solar Charger as a Switch accessory in HomeKit.
 * When the switch is ON, the plugin actively monitors Sense solar production
 * and adjusts the Tesla charging rate accordingly.
 * When OFF, charging management is paused.
 */
export class EvSolarChargerAccessory {
  private service: Service;

  /**
   * Internal state tracking whether solar-optimized charging is active.
   */
  private isActive = false;

  /**
   * Polling timer reference for the solar/charging update loop.
   */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly platform: EvSolarChargerPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'homebridge-ev-solar-charger')
      .setCharacteristic(this.platform.Characteristic.Model, 'EV Solar Charger Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.UUID);

    // Get or create the Switch service
    this.service = this.accessory.getService(this.platform.Service.Switch)
      || this.accessory.addService(this.platform.Service.Switch);

    // Set the service name (shown in the Home app)
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device?.displayName ?? 'EV Solar Charger',
    );

    // Register handlers for the On/Off characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));
  }

  /**
   * Handle GET requests for the Switch On characteristic.
   * Called by Homebridge when HomeKit asks for the current state.
   */
  async handleOnGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('GET Switch On ->', this.isActive);
    return this.isActive;
  }

  /**
   * Handle SET requests for the Switch On characteristic.
   * Called by Homebridge when the user toggles the switch in HomeKit.
   */
  async handleOnSet(value: CharacteristicValue) {
    this.isActive = value as boolean;
    this.platform.log.info('SET Switch On ->', this.isActive);

    if (this.isActive) {
      this.startChargeOptimization();
    } else {
      this.stopChargeOptimization();
    }
  }

  /**
   * Start the solar-optimized charging loop.
   * Polls Sense for solar production data and adjusts Tesla charging rate.
   */
  private startChargeOptimization() {
    const intervalMs = ((this.platform.config.pollingIntervalSeconds as number) ?? 60) * 1000;

    this.platform.log.info('Starting solar charge optimization (interval: %ds)', intervalMs / 1000);

    // Run immediately, then on each interval
    this.runOptimizationCycle();

    this.pollingTimer = setInterval(() => {
      this.runOptimizationCycle();
    }, intervalMs);
  }

  /**
   * Stop the solar-optimized charging loop.
   */
  private stopChargeOptimization() {
    this.platform.log.info('Stopping solar charge optimization');

    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Execute a single optimization cycle:
   *   1. Fetch current solar production from Sense
   *   2. Fetch current Tesla charging state
   *   3. Adjust charging amps based on available solar surplus
   *
   * TODO: Implement Sense API integration
   * TODO: Implement Tesla Fleet API / TeslaJS integration
   */
  private async runOptimizationCycle() {
    try {
      this.platform.log.debug('Running optimization cycle...');

      // Placeholder: replace with real Sense API call
      const solarProductionWatts = await this.fetchSolarProduction();

      // Placeholder: replace with real Tesla API call
      const currentChargeAmps = await this.fetchTeslaChargeAmps();

      const targetAmps = this.calculateTargetAmps(solarProductionWatts);

      if (targetAmps !== currentChargeAmps) {
        this.platform.log.info(
          'Adjusting charge rate: %dA -> %dA (solar: %dW)',
          currentChargeAmps,
          targetAmps,
          solarProductionWatts,
        );
        // TODO: await this.setTeslaChargeAmps(targetAmps);
      }
    } catch (err) {
      this.platform.log.error('Error during optimization cycle:', err);
    }
  }

  /**
   * Calculate the optimal charging current based on available solar surplus.
   *
   * @param solarWatts - Current solar production in watts
   * @returns Target charging current in amps
   */
  private calculateTargetAmps(solarWatts: number): number {
    const minAmps = (this.platform.config.minimumChargeAmps as number) ?? 5;
    const maxAmps = (this.platform.config.maximumChargeAmps as number) ?? 32;

    // Assume 240V single-phase; convert watts to amps
    const availableAmps = Math.floor(solarWatts / 240);

    return Math.min(maxAmps, Math.max(minAmps, availableAmps));
  }

  // ---------------------------------------------------------------------------
  // Stub methods — replace with real API integrations
  // ---------------------------------------------------------------------------

  /** Fetch current solar production from Sense Energy Monitor (stub). */
  private async fetchSolarProduction(): Promise<number> {
    // TODO: Implement Sense WebSocket / REST API integration
    return 0;
  }

  /** Fetch current Tesla charging amps (stub). */
  private async fetchTeslaChargeAmps(): Promise<number> {
    // TODO: Implement Tesla Fleet API integration
    return 0;
  }
}
