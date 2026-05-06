import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import inquirer from 'inquirer';
import { dump as toYaml } from 'js-yaml';
import { type AppConfig, loadConfig, validateConfig } from '@homebridge-ev-solar-charger/core';

const DEFAULT_CONFIG_PATH = './config.yaml';

// ---- Entry point ------------------------------------------------------------

export async function runSetup(): Promise<void> {
  printBanner();

  const configPath = resolve(DEFAULT_CONFIG_PATH);
  const existing = tryLoadExisting(configPath);

  if (existing) {
    await runUpdateWizard(existing, configPath);
  } else {
    await runFullSetup(configPath);
  }
}

// ---- Full first-run setup ---------------------------------------------------

async function runFullSetup(configPath: string): Promise<void> {
  const sense = await promptSense();
  const tesla = await promptTesla();
  const charging = await promptCharging();

  const config: AppConfig = { sense, tesla, charging };
  await confirmAndWrite(config, configPath);
}

// ---- Update wizard (config already exists) ----------------------------------

async function runUpdateWizard(existing: AppConfig, configPath: string): Promise<void> {
  console.log(`  Found existing config: ${configPath}\n`);

  const { sections } = await inquirer.prompt<{ sections: string[] }>([
    {
      type: 'checkbox',
      name: 'sections',
      message: 'Which sections do you want to update? (space to select, enter to confirm)',
      choices: [
        { name: 'Sense credentials  (email / password)', value: 'sense' },
        { name: 'Tesla credentials  (Fleet API client ID + secret)', value: 'tesla' },
        { name: 'Charging settings  (amps, interval, stop behaviour)', value: 'charging' },
      ],
    },
  ]);

  if (sections.length === 0) {
    console.log('\nNothing selected — config unchanged.');
    return;
  }

  const config: AppConfig = { ...existing };

  if (sections.includes('sense')) {
    config.sense = await promptSense(existing.sense);
  }
  if (sections.includes('tesla')) {
    config.tesla = await promptTesla(existing.tesla);
  }
  if (sections.includes('charging')) {
    config.charging = await promptCharging(existing.charging);
  }

  await confirmAndWrite(config, configPath);
}

// ---- Section prompts --------------------------------------------------------

async function promptSense(current?: AppConfig['sense']): Promise<AppConfig['sense']> {
  console.log('\n  Sense Energy Monitor\n  ─────────────────────');
  if (current) {
    console.log(`  Current email: ${current.email}`);
  }

  return inquirer.prompt<AppConfig['sense']>([
    {
      type: 'input',
      name: 'email',
      message: 'Sense account email:',
      default: current?.email,
      validate: (v: string) => /\S+@\S+\.\S+/.test(v) || 'Enter a valid email address',
    },
    {
      type: 'password',
      name: 'password',
      message: current ? 'Sense account password (enter to keep current):' : 'Sense account password:',
      mask: '*',
      validate: (v: string) => {
        if (current && v.length === 0) return true; // keep existing
        return v.length > 0 || 'Password is required';
      },
    },
  ]).then((answers) => ({
    email: answers.email,
    password: answers.password.length > 0 ? answers.password : current!.password,
  }));
}

async function promptTesla(current?: AppConfig['tesla']): Promise<AppConfig['tesla']> {
  console.log('\n  Tesla Fleet API\n  ────────────────');
  if (current) {
    console.log(`  Current client ID: ${current.fleet_client_id}`);
  }

  const { fleet_client_id } = await inquirer.prompt<{ fleet_client_id: string }>([
    {
      type: 'input',
      name: 'fleet_client_id',
      message: 'Fleet API client ID (UUID from developer.tesla.com):',
      default: current?.fleet_client_id,
      validate: (v: string) => v.trim().length > 0 || 'Client ID is required',
    },
  ]);

  const { fleet_api_key } = await inquirer.prompt<{ fleet_api_key: string }>([
    {
      type: 'password',
      name: 'fleet_api_key',
      message: current ? 'Fleet API client secret (enter to keep current):' : 'Fleet API client secret:',
      mask: '*',
      validate: (v: string) => {
        if (current && v.length === 0) return true;
        return v.length > 0 || 'Client secret is required';
      },
    },
  ]);

  const { email, vin } = await inquirer.prompt<{ email: string; vin: string }>([
    {
      type: 'input',
      name: 'email',
      message: 'Tesla account email (optional):',
      default: current?.email ?? '',
    },
    {
      type: 'input',
      name: 'vin',
      message: 'Vehicle VIN (leave blank to use the first vehicle on the account):',
      default: current?.vin ?? '',
    },
  ]);

  const tesla: AppConfig['tesla'] = {
    fleet_client_id: fleet_client_id.trim(),
    fleet_api_key: fleet_api_key.length > 0 ? fleet_api_key : current!.fleet_api_key,
  };
  if (email) tesla.email = email;
  if (vin) tesla.vin = vin.toUpperCase();
  return tesla;
}

async function promptCharging(current?: AppConfig['charging']): Promise<AppConfig['charging']> {
  console.log('\n  Charging Settings\n  ──────────────────');

  return inquirer.prompt<AppConfig['charging']>([
    {
      type: 'number',
      name: 'min_amps',
      message: 'Minimum charging amps (start/stop threshold):',
      default: current?.min_amps ?? 5,
      validate: (v: number) => (Number.isInteger(v) && v >= 1 && v <= 48) || 'Must be a whole number 1–48',
    },
    {
      type: 'number',
      name: 'max_amps',
      message: 'Maximum charging amps:',
      default: current?.max_amps ?? 32,
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
      default: current?.poll_interval_seconds ?? 60,
      validate: (v: number) => (Number.isInteger(v) && v >= 10) || 'Must be a whole number >= 10',
    },
    {
      type: 'confirm',
      name: 'stop_when_insufficient',
      message: 'Stop charging when surplus drops below minimum amps?',
      default: current?.stop_when_insufficient ?? true,
    },
  ]);
}

// ---- Shared confirm + write -------------------------------------------------

async function confirmAndWrite(config: AppConfig, configPath: string): Promise<void> {
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
  console.log('Run `node packages/cli/dist/index.js` to begin.\n');
}

// ---- Output -----------------------------------------------------------------

function printBanner(): void {
  console.log();
  console.log('  EV Solar Charger — Setup');
  console.log('  ─────────────────────────');
  console.log('  Secrets are stored in plain text; restrict file permissions if needed.');
  console.log();
}

function printSummary(config: AppConfig, configPath: string): void {
  const { sense, tesla, charging } = config;
  console.log('\n  Summary\n  ───────');
  console.log(`  Output path          : ${configPath}`);
  console.log(`  Sense email          : ${sense.email}`);
  console.log(`  Sense password       : ${'*'.repeat(8)}`);
  console.log(`  Tesla client ID      : ${tesla.fleet_client_id}`);
  console.log(`  Tesla client secret  : ${'*'.repeat(8)}`);
  if (tesla.email) console.log(`  Tesla email          : ${tesla.email}`);
  if (tesla.vin)   console.log(`  Tesla VIN            : ${tesla.vin}`);
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
  writeFileSync(absPath, yaml, { encoding: 'utf8', mode: 0o600 });
}

// ---- Helpers ----------------------------------------------------------------

function tryLoadExisting(configPath: string): AppConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    return loadConfig(configPath);
  } catch {
    return null;
  }
}
