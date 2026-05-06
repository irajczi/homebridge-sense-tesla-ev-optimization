#!/usr/bin/env node
/**
 * index.ts — Standalone CLI entry point for the EV Solar Charger.
 *
 * Execution flow:
 *   1. If no config file is found, launches the interactive setup wizard
 *      (packages/cli/src/setup.ts) which writes config.yaml and returns.
 *   2. Loads and validates config.yaml (or the path in $EV_CONFIG_PATH).
 *   3. Constructs SenseClient, TeslaClient, and SolarChargeController from core.
 *   4. Connects to the Sense WebSocket — hard failure if this step errors
 *      (wrong credentials, network unavailable).
 *   5. Starts the controller polling loop.
 *   6. Wires SIGINT / SIGTERM for graceful shutdown (stops controller + closes
 *      the Sense WebSocket before exiting).
 *
 * Logging format: [YYYY-MM-DD HH:MM:SS.mmm] [LEVEL] message
 *   Errors go to stderr; all other levels go to stdout.
 *
 * Environment:
 *   EV_CONFIG_PATH  — override config file location (default: ./config.yaml)
 *
 * Error paths:
 *   - config.yaml missing + setup wizard cancelled → exits 0
 *   - config.yaml invalid                          → exits 1 (validateConfig throws)
 *   - Sense connection failure                     → exits 1 with error message
 *   - Any unhandled top-level rejection            → exits 1 via main().catch()
 */

import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { dump as toYaml } from 'js-yaml';
import {
  loadConfig,
  SenseClient,
  TeslaClient,
  SolarChargeController,
  type LogLevel,
  type AppConfig,
} from '@homebridge-ev-solar-charger/core';
import { runSetup } from './setup.js';

const CONFIG_PATH = resolve(process.env.EV_CONFIG_PATH ?? './config.yaml');

// ---- Bootstrap --------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    console.log(`No config found at ${CONFIG_PATH}. Starting first-run setup…\n`);
    await runSetup();
    if (!existsSync(CONFIG_PATH)) process.exit(0);
  }

  let config;
  try {
    config = loadConfig(CONFIG_PATH);
  } catch (err) {
    console.log(`Config at ${CONFIG_PATH} is invalid: ${(err as Error).message}\n`);
    console.log('Launching setup wizard to update it…\n');
    await runSetup();
    if (!existsSync(CONFIG_PATH)) process.exit(0);
    config = loadConfig(CONFIG_PATH);
  }

  const sense = new SenseClient(
    config.sense.email,
    config.sense.password,
    (level, msg) => log(level, `[Sense] ${msg}`),
  );

  const tesla = new TeslaClient(config.tesla, (newToken) => {
    config.tesla.refresh_token = newToken;
    persistRefreshToken(CONFIG_PATH, config, newToken);
  });

  const controller = new SolarChargeController(config, sense, tesla);

  // ---- Event logging --------------------------------------------------------

  controller.on('log', (level: LogLevel, message: string) => {
    log(level, message);
  });

  controller.on('charging:start', (amps: number) => {
    log('info', `--- charging started at ${amps}A ---`);
  });

  controller.on('charging:stop', () => {
    log('info', '--- charging stopped ---');
  });

  controller.on('amps:adjust', (from: number, to: number) => {
    const arrow = to > from ? '▲' : '▼';
    log('info', `--- amps ${arrow} ${from}A → ${to}A ---`);
  });

  // ---- Graceful shutdown ----------------------------------------------------

  let stopping = false;

  function shutdown(signal: string): void {
    if (stopping) return;
    stopping = true;
    log('info', `${signal} received — shutting down`);
    controller.stop();
    sense.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ---- Start ----------------------------------------------------------------

  log('info', `Loaded config from ${CONFIG_PATH}`);
  log('info', 'Connecting to Sense…');

  try {
    await sense.connect();
  } catch (err) {
    log('error', `Sense connection failed: ${(err as Error).message}`);
    process.exit(1);
  }

  log('info', 'Sense connected');
  controller.start();
}

// ---- Logging ----------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(level: LogLevel, message: string): void {
  const prefix = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// ---- Token persistence ------------------------------------------------------

function persistRefreshToken(configPath: string, config: AppConfig, newToken: string): void {
  try {
    config.tesla.refresh_token = newToken;
    const yaml = toYaml(config, { lineWidth: 120, quotingType: '"' });
    writeFileSync(configPath, yaml, { encoding: 'utf8', mode: 0o600 });
    log('info', 'Refresh token rotated and saved to config');
  } catch (err) {
    log('error', `Failed to save rotated refresh token: ${(err as Error).message}`);
  }
}

// ---- Run --------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error('[FATAL]', (err as Error).message);
  process.exit(1);
});
