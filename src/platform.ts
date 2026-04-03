import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { EvSolarChargerAccessory } from './platformAccessory.js';

/**
 * EvSolarChargerPlatform
 *
 * This is the main class for the EV Solar Charger platform plugin.
 * It parses the user config, discovers/registers accessories, and
 * manages the lifecycle of each accessory instance.
 */
export class EvSolarChargerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Cache of restored accessories from disk
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    // Homebridge 1.8.0 introduced a `ready` event. Wait for it before
    // discovering / registering accessories.
    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * Called by Homebridge to restore cached accessories from disk.
   * Must call `configureAccessory` for each cached accessory.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Discover and register accessories.
   *
   * For this plugin, we register a single "virtual" switch accessory that
   * represents the solar-optimized EV charging controller.
   */
  discoverDevices() {
    // A single virtual device representing the EV charging controller
    const devices = [
      {
        uniqueId: 'ev-solar-charger-controller',
        displayName: this.config.name as string || 'EV Solar Charger',
      },
    ];

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.uniqueId);

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // Accessory already exists — restore from cache
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        new EvSolarChargerAccessory(this, existingAccessory);
      } else {
        // Create a new accessory
        this.log.info('Adding new accessory:', device.displayName);
        const accessory = new this.api.platformAccessory(device.displayName, uuid);

        // Store a reference to the device config in the accessory context
        accessory.context.device = device;

        new EvSolarChargerAccessory(this, accessory);

        // Register the accessory with Homebridge
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
