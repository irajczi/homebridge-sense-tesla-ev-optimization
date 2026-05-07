/**
 * platform.ts — Homebridge DynamicPlatformPlugin implementation.
 *
 * Responsible for:
 *   1. Translating the flat Homebridge PlatformConfig into the nested AppConfig
 *      expected by the core package (`buildAppConfig()`).
 *   2. Constructing the shared SenseClient and TeslaClient instances (one set
 *      per Homebridge instance, shared with all accessories).
 *   3. Connecting to Sense on `didFinishLaunching`. If the connection fails, the
 *      plugin continues and registers accessories anyway so the switch is visible
 *      in HomeKit — it just won't be able to adjust charge amps until Sense reconnects.
 *   4. Registering (or restoring from cache) the single virtual switch accessory.
 *
 * Config field mapping (Homebridge → AppConfig):
 *   See `buildAppConfig()` at the bottom of this file for the authoritative map.
 *   The Homebridge schema (config.schema.json) uses camelCase field names;
 *   AppConfig uses snake_case nested fields — buildAppConfig bridges the two.
 *
 * Error paths:
 *   - Sense connection failure on launch
 *     → logged as error; `discoverDevices()` still runs so the switch appears.
 *   - Invalid config values (missing email, etc.)
 *     → `validateConfig()` is NOT called here; Homebridge Config UI X enforces
 *       the schema. Raw missing values become undefined/null in AppConfig and
 *       will cause descriptive errors on first Tesla or Sense API call.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import {
  AppConfig,
  SenseClient,
  TeslaClient,
  geocodeHomeAddress,
  needsAddressResolution,
} from '@homebridge-ev-solar-charger/core';
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

    // Homebridge's persist directory survives restarts and plugin updates.
    // We store a rotated refresh token here so it takes precedence over the
    // (potentially stale) value in Homebridge's config.json.
    const tokenPersistPath = join(this.api.user.persistPath(), 'ev-solar-charger-refresh-token.txt');
    const teslaConfig = { ...this.appConfig.tesla };
    try {
      const saved = readFileSync(tokenPersistPath, 'utf8').trim();
      if (saved) {
        teslaConfig.refresh_token = saved;
        this.log.debug('Loaded rotated refresh token from plugin storage');
      }
    } catch { /* no persisted token yet — use config value */ }

    this.tesla = new TeslaClient(teslaConfig, (newToken) => {
      try {
        writeFileSync(tokenPersistPath, newToken, { encoding: 'utf8', mode: 0o600 });
        this.log.debug('Refresh token rotated and saved to plugin storage');
      } catch (err) {
        this.log.error('Failed to save rotated refresh token:', (err as Error).message);
      }
    });

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.resolveHomeAddressIfNeeded()
        .catch((err: Error) => {
          this.log.error('Failed to resolve home address:', err.message);
        })
        .then(() => this.sense.connect())
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

  private async resolveHomeAddressIfNeeded(): Promise<void> {
    if (!needsAddressResolution(this.appConfig.home)) return;

    const address = this.appConfig.home!.address!.trim();
    this.log.info(`Resolving home address with OpenStreetMap Nominatim: ${address}`);
    this.log.info('Address lookup is performed from this Homebridge host and cached in memory for this run');

    const resolved = await geocodeHomeAddress(address);
    this.appConfig.home = {
      ...this.appConfig.home,
      address,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      timezone: this.appConfig.home?.timezone?.trim() || resolved.suggestedTimezone,
      radius_meters: this.appConfig.home?.radius_meters ?? 150,
      geocoded_address: resolved.displayName,
      address_last_resolved: address,
    };

    this.log.info(
      `Home resolved to ${resolved.latitude.toFixed(6)}, ${resolved.longitude.toFixed(6)} ` +
      `(${this.appConfig.home.timezone})`,
    );
    this.log.info(resolved.attribution);
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
 * Schema field               → AppConfig field
 * ──────────────────────────────────────────────────────────────
 * senseEmail                 → sense.email
 * sensePassword              → sense.password
 * fleetClientId              → tesla.fleet_client_id
 * fleetApiKey                → tesla.fleet_api_key
 * teslaRefreshToken          → tesla.refresh_token
 * teslaRedirectUri           → tesla.redirect_uri
 * teslaEmail                 → tesla.email
 * vehicleVIN                 → tesla.vin
 * minimumChargeAmps          → charging.min_amps
 * maximumChargeAmps          → charging.max_amps
 * pollingIntervalSeconds     → charging.poll_interval_seconds
 * stopWhenInsufficient       → charging.stop_when_insufficient
 * adaptivePollingEnabled     → charging.adaptive_polling.enabled
 * adaptiveStableAfterMinutes → charging.adaptive_polling.stable_after_minutes
 * adaptiveStableInterval...  → charging.adaptive_polling.stable_interval_seconds
 * adaptiveChangeThreshold... → charging.adaptive_polling.change_threshold_watts
 * autoOffAfterNoSolarMinutes → homebridge.auto_off_after_no_solar_minutes
 * homeAddress                → home.address
 * homeLatitude               → home.latitude
 * homeLongitude              → home.longitude
 * homeTimezone               → home.timezone
 * homeRadiusMeters           → home.radius_meters
 * dailyWakeEnabled           → automation.daily_wake_enabled
 * wakeAfterSunriseMinutes    → automation.wake_after_sunrise_minutes
 * sleepAfterInsufficient...  → automation.sleep_after_insufficient_minutes
 * powerExpensiveStartTime    → automation.power_expensive_start_time
 */
function buildAppConfig(config: PlatformConfig): AppConfig {
  return {
    sense: {
      email: config.senseEmail as string,
      password: config.sensePassword as string,
    },
    tesla: {
      fleet_client_id: config.fleetClientId as string,
      fleet_api_key: config.fleetApiKey as string,
      refresh_token: config.teslaRefreshToken as string,
      redirect_uri: config.teslaRedirectUri as string,
      email: config.teslaEmail as string | undefined,
      vin: config.vehicleVIN as string | undefined,
    },
    charging: {
      min_amps: (config.minimumChargeAmps as number) ?? 5,
      max_amps: (config.maximumChargeAmps as number) ?? 32,
      poll_interval_seconds: (config.pollingIntervalSeconds as number) ?? 60,
      stop_when_insufficient: (config.stopWhenInsufficient as boolean) ?? true,
      adaptive_polling: {
        enabled: (config.adaptivePollingEnabled as boolean) ?? false,
        stable_after_minutes: (config.adaptiveStableAfterMinutes as number | undefined) ?? 2,
        stable_interval_seconds: (config.adaptiveStableIntervalSeconds as number | undefined) ?? 300,
        change_threshold_watts: (config.adaptiveChangeThresholdWatts as number | undefined) ?? 250,
      },
    },
    homebridge: {
      auto_off_after_no_solar_minutes:
        (config.autoOffAfterNoSolarMinutes as number | undefined) ?? null,
    },
    home: {
      address: config.homeAddress as string | undefined,
      latitude: config.homeLatitude as number | undefined,
      longitude: config.homeLongitude as number | undefined,
      timezone: config.homeTimezone as string | undefined,
      radius_meters: (config.homeRadiusMeters as number | undefined) ?? 150,
    },
    automation: {
      daily_wake_enabled: (config.dailyWakeEnabled as boolean) ?? false,
      wake_after_sunrise_minutes: (config.wakeAfterSunriseMinutes as number | undefined) ?? 30,
      sleep_after_insufficient_minutes:
        (config.sleepAfterInsufficientMinutes as number | undefined) ?? null,
      power_expensive_start_time:
        ((config.powerExpensiveStartTime as string | undefined)?.trim() || null),
    },
  };
}
