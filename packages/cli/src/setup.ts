/**
 * Interactive first-run setup wizard.
 * Prompts for all required credentials and settings, validates the result,
 * then writes a config.yaml to the user-chosen path.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import inquirer from 'inquirer';
import { dump as toYaml } from 'js-yaml';
import { type AppConfig, validateConfig } from '@homebridge-ev-solar-charger/core';

const DEFAULT_CONFIG_PATH = './config.yaml';

// ---- Entry point ------------------------------------------------------------

export async function runSetup(): Promise<void> {
  printBanner();

  const configPath = await promptConfigPath();
  if (configPath === null) return; // user declined overwrite

  const sense = await promptSense();
  const tesla = await promptTesla();
  const charging = await promptCharging();

  const config: AppConfig = { sense, tesla, charging };

  // Run the same validation loadConfig would use — surface any logic errors
  // before touching the filesystem.
  try {
    validateConfig(config);
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    process.exit(1);
  }

  printSummary(config, configPath);

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: 'Write this config?',
      default: true,
    },
  ]);

  if (!confirmed) {
    console.log('\nSetup cancelled — nothing was written.');
    return;
  }

  writeConfig(config, configPath);

  console.log(`\nConfig written to: ${configPath}`);
  console.log('Run `ev-solar-charger start` to begin.\n');
}

// ---- Section prompts --------------------------------------------------------

async function promptConfigPath(): Promise<string | null> {
  const { rawPath } = await inquirer.prompt<{ rawPath: string }>([
    {
      type: 'input',
      name: 'rawPath',
      message: 'Where should the config file be saved?',
      default: DEFAULT_CONFIG_PATH,
    },
  ]);

  const absPath = resolve(rawPath);

  if (existsSync(absPath)) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `"${absPath}" already exists. Overwrite?`,
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log('\nSetup cancelled — existing file kept.');
      return null;
    }
  }

  return absPath;
}

async function promptSense(): Promise<AppConfig['sense']> {
  console.log('\n  Sense Energy Monitor\n  ─────────────────────');

  return inquirer.prompt<AppConfig['sense']>([
    {
      type: 'input',
      name: 'email',
      message: 'Sense account email:',
      validate: (v: string) => /\S+@\S+\.\S+/.test(v) || 'Enter a valid email address',
    },
    {
      type: 'password',
      name: 'password',
      message: 'Sense account password:',
      mask: '*',
      validate: (v: string) => v.length > 0 || 'Password is required',
    },
  ]);
}

async function promptTesla(): Promise<AppConfig['tesla']> {
  console.log('\n  Tesla\n  ─────');

  const { mode } = await inquirer.prompt<{ mode: AppConfig['tesla']['mode'] }>([
    {
      type: 'list',
      name: 'mode',
      message: 'API mode:',
      choices: [
        {
          name: "Owner's API  (personal use — OAuth2 refresh token)",
          value: 'owners_api',
        },
        {
          name: 'Fleet API    (third-party app — fleet API key)',
          value: 'fleet_api',
        },
      ],
    },
  ]);

  let modeCredentials: Partial<AppConfig['tesla']>;

  if (mode === 'owners_api') {
    const { password } = await inquirer.prompt<{ password: string }>([
      {
        type: 'password',
        name: 'password',
        message: 'Tesla OAuth2 refresh token:',
        mask: '*',
        validate: (v: string) => v.length > 0 || 'Refresh token is required',
      },
    ]);
    modeCredentials = { password };
  } else {
    const { fleet_client_id } = await inquirer.prompt<{ fleet_client_id: string }>([
      {
        type: 'input',
        name: 'fleet_client_id',
        message: 'Fleet API client ID (UUID from developer.tesla.com):',
        validate: (v: string) => v.trim().length > 0 || 'Client ID is required',
      },
    ]);
    const { fleet_api_key } = await inquirer.prompt<{ fleet_api_key: string }>([
      {
        type: 'password',
        name: 'fleet_api_key',
        message: 'Fleet API client secret:',
        mask: '*',
        validate: (v: string) => v.length > 0 || 'Client secret is required',
      },
    ]);
    modeCredentials = { fleet_client_id, fleet_api_key };
  }

  const { email, vin } = await inquirer.prompt<{ email: string; vin: string }>([
    {
      type: 'input',
      name: 'email',
      message: 'Tesla account email (optional):',
    },
    {
      type: 'input',
      name: 'vin',
      message: 'Vehicle VIN (leave blank to use the first vehicle on the account):',
    },
  ]);

  const tesla: AppConfig['tesla'] = { mode, ...modeCredentials };
  if (email) tesla.email = email;
  if (vin) tesla.vin = vin;
  return tesla;
}

async function promptCharging(): Promise<AppConfig['charging']> {
  console.log('\n  Charging Settings\n  ──────────────────');

  return inquirer.prompt<AppConfig['charging']>([
    {
      type: 'number',
      name: 'min_amps',
      message: 'Minimum charging amps (start/stop threshold):',
      default: 5,
      validate: (v: number) => (Number.isInteger(v) && v >= 1 && v <= 48) || 'Must be a whole number 1–48',
    },
    {
      type: 'number',
      name: 'max_amps',
      message: 'Maximum charging amps:',
      default: 32,
      validate(v: number, answers: Partial<AppConfig['charging']>) {
        if (!Number.isInteger(v) || v < 1 || v > 48) return 'Must be a whole number 1–48';
        if (answers.min_amps !== undefined && v < answers.min_amps) {
          return `Must be >= min_amps (${answers.min_amps})`;
        }
        return true;
      },
    },
    {
      type: 'number',
      name: 'poll_interval_seconds',
      message: 'Sense polling interval (seconds):',
      default: 60,
      validate: (v: number) => (Number.isInteger(v) && v >= 10) || 'Must be a whole number >= 10',
    },
    {
      type: 'confirm',
      name: 'stop_when_insufficient',
      message: 'Stop charging when surplus drops below minimum amps?',
      default: true,
    },
  ]);
}

// ---- Output -----------------------------------------------------------------

function printBanner(): void {
  console.log();
  console.log('  EV Solar Charger — First-run Setup');
  console.log('  ────────────────────────────────────');
  console.log('  This wizard creates your config.yaml.');
  console.log('  Secrets are stored in plain text; restrict file permissions if needed.');
  console.log();
}

function printSummary(config: AppConfig, configPath: string): void {
  const { sense, tesla, charging } = config;
  console.log('\n  Summary\n  ───────');
  console.log(`  Output path          : ${configPath}`);
  console.log(`  Sense email          : ${sense.email}`);
  console.log(`  Sense password       : ${'*'.repeat(8)}`);
  console.log(`  Tesla mode           : ${tesla.mode}`);
  if (tesla.email) console.log(`  Tesla email          : ${tesla.email}`);
  if (tesla.vin) console.log(`  Tesla VIN            : ${tesla.vin}`);
  if (tesla.mode === 'owners_api') {
    console.log(`  Tesla Refresh token  : ${'*'.repeat(8)}`);
  } else {
    console.log(`  Tesla Client ID      : ${tesla.fleet_client_id}`);
    console.log(`  Tesla Client secret  : ${'*'.repeat(8)}`);
  }
  console.log(`  Min amps             : ${charging.min_amps}A`);
  console.log(`  Max amps             : ${charging.max_amps}A`);
  console.log(`  Poll interval        : ${charging.poll_interval_seconds}s`);
  console.log(`  Stop when low        : ${charging.stop_when_insufficient}`);
  console.log();
}

function writeConfig(config: AppConfig, absPath: string): void {
  const dir = dirname(absPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const yaml = toYaml(config, { lineWidth: 120, quotingType: '"' });
  // 0o600 = owner read/write only — appropriate for a file containing credentials
  writeFileSync(absPath, yaml, { encoding: 'utf8', mode: 0o600 });
}
