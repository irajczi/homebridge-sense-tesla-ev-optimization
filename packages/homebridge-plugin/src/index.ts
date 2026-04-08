/**
 * index.ts — Homebridge plugin entry point for homebridge-ev-solar-charger.
 *
 * Homebridge requires every plugin to export a default function that receives
 * the HAP-nodejs `API` object and calls `api.registerPlatform()`.
 *
 * The platform name passed here (`EvSolarCharger`) must exactly match:
 *   - `pluginAlias` in config.schema.json
 *   - `"platform"` in the user's Homebridge config.json
 *
 * All real logic lives in platform.ts and accessory.ts; this file is
 * intentionally a thin registration shim.
 */

import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings.js';
import { EvSolarChargerPlatform } from './platform.js';

/**
 * This method registers the platform with Homebridge.
 * The name provided here must match the `pluginAlias` in config.schema.json.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, EvSolarChargerPlatform);
};
