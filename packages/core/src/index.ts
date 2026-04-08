/**
 * index.ts — Public API surface for @homebridge-ev-solar-charger/core.
 *
 * Re-exports everything the CLI and Homebridge plugin need. Importers should
 * only reference this barrel file, never individual modules within the package,
 * so internal refactoring doesn't break external consumers.
 */

export { AppConfig, loadConfig, validateConfig } from './config.js';
export { SenseClient } from './sense.js';
export { TeslaClient, Vehicle } from './tesla.js';
export { SolarChargeController, type LogLevel } from './controller.js';
