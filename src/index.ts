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
