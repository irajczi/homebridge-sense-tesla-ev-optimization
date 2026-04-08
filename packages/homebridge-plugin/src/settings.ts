/**
 * settings.ts — Shared string constants for the Homebridge plugin.
 *
 * Centralising these avoids typos when the platform/plugin name must appear in
 * multiple places (registration, logging, schema). Both values must stay in
 * sync with the `name` field in package.json and `pluginAlias` in
 * config.schema.json.
 */

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'EvSolarCharger';

/**
 * This must match the name of your plugin as defined the package.json `name` property
 */
export const PLUGIN_NAME = 'homebridge-ev-solar-charger';
