import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { AppConfig, SenseClient, TeslaClient } from '@homebridge-ev-solar-charger/core';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { EvSolarChargerAccessory } from './accessory.js';

/**
 * EvSolarChargerPlatform
 *
 * Main platform class. Reads the Homebridge config, constructs the core
 * SenseClient and TeslaClient, connects to Sense on launch, then registers
 * the single virtual switch accessory that drives the charge controller.
 */
export class EvSolarChargerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Cache of restored accessories from disk
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  // Core clients shared with accessories
  public readonly appConfig: AppConfig;
  public readonly sense: SenseClient;
  public readonly tesla: TeslaClient;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.appConfig = buildAppConfig(config);
    this.sense = new SenseClient(
      this.appConfig.sense.email,
      this.appConfig.sense.password,
      (level, msg) => this.log[level](`[Sense] ${msg}`),
    );
    this.tesla = new TeslaClient(this.appConfig.tesla);

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.sense.connect()
        .then(() => {
          this.log.info('Connected to Sense Energy Monitor');
          this.discoverDevices();
        })
        .catch((err: Error) => {
          this.log.error('Failed to connect to Sense Energy Monitor:', err.message);
          // Still register accessories so the switch is visible even without Sense.
          this.discoverDevices();
        });
    });
  }

  /**
   * Called by Homebridge to restore cached accessories from disk.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Register the single virtual switch accessory.
   */
  discoverDevices() {
    const device = {
      uniqueId: 'ev-solar-charger-controller',
      displayName: (this.config.name as string) || 'EV Solar Charger',
    };

    const uuid = this.api.hap.uuid.generate(device.uniqueId);
    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      new EvSolarChargerAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding new accessory:', device.displayName);
      const accessory = new this.api.platformAccessory(device.displayName, uuid);
      accessory.context.device = device;
      new EvSolarChargerAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}

/**
 * Map the flat Homebridge PlatformConfig to the nested AppConfig expected by core.
 *
 * Schema field          → AppConfig field
 * ─────────────────────────────────────────────────────────────
 * senseEmail            → sense.email
 * sensePassword         → sense.password
 * teslaMode             → tesla.mode  ('owners_api' | 'fleet_api')
 * teslaEmail            → tesla.email
 * teslaRefreshToken     → tesla.password        (owners_api only)
 * fleetClientId         → tesla.fleet_client_id (fleet_api only)
 * fleetApiKey           → tesla.fleet_api_key   (fleet_api only)
 * vehicleVIN            → tesla.vin
 * minimumChargeAmps     → charging.min_amps
 * maximumChargeAmps     → charging.max_amps
 * pollingIntervalSeconds→ charging.poll_interval_seconds
 * stopWhenInsufficient  → charging.stop_when_insufficient
 * autoOffAfterNoSolarMinutes → homebridge.auto_off_after_no_solar_minutes
 */
function buildAppConfig(config: PlatformConfig): AppConfig {
  const mode: AppConfig['tesla']['mode'] =
    config.teslaMode === 'fleet_api' ? 'fleet_api' : 'owners_api';

  return {
    sense: {
      email: config.senseEmail as string,
      password: config.sensePassword as string,
    },
    tesla: {
      mode,
      email: config.teslaEmail as string | undefined,
      password: config.teslaRefreshToken as string | undefined,
      fleet_client_id: config.fleetClientId as string | undefined,
      fleet_api_key: config.fleetApiKey as string | undefined,
      vin: config.vehicleVIN as string | undefined,
    },
    charging: {
      min_amps: (config.minimumChargeAmps as number) ?? 5,
      max_amps: (config.maximumChargeAmps as number) ?? 32,
      poll_interval_seconds: (config.pollingIntervalSeconds as number) ?? 60,
      stop_when_insufficient: (config.stopWhenInsufficient as boolean) ?? true,
    },
    homebridge: {
      auto_off_after_no_solar_minutes:
        (config.autoOffAfterNoSolarMinutes as number | undefined) ?? null,
    },
  };
}
