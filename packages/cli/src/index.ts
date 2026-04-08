#!/usr/bin/env node

import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  loadConfig,
  SenseClient,
  TeslaClient,
  SolarChargeController,
  type LogLevel,
} from '@homebridge-ev-solar-charger/core';
import { runSetup } from './setup.js';

const CONFIG_PATH = resolve(process.env.EV_CONFIG_PATH ?? './config.yaml');

// ---- Bootstrap --------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    console.log(`No config found at ${CONFIG_PATH}. Starting first-run setup…\n`);
    await runSetup();
    // If setup was cancelled (no file written), exit cleanly.
    if (!existsSync(CONFIG_PATH)) {
      process.exit(0);
    }
  }

  const config = loadConfig(CONFIG_PATH);

  const sense = new SenseClient(
    config.sense.email,
    config.sense.password,
    (level, msg) => log(level, `[Sense] ${msg}`),
  );

  const tesla = new TeslaClient(config.tesla);

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

// ---- Run --------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error('[FATAL]', (err as Error).message);
  process.exit(1);
});
