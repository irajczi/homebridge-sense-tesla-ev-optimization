import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import inquirer from 'inquirer';
import { dump as toYaml } from 'js-yaml';
import { type AppConfig, loadConfig, validateConfig } from '@homebridge-ev-solar-charger/core';

const TESLA_AUTH_URL = 'https://auth.tesla.com/oauth2/v3';
const TESLA_REDIRECT_URI = 'https://irajczi.github.io/homebridge-sense-tesla-ev-optimization/callback';
const TESLA_SCOPE = 'openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds';

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
      filter: (v: string) => v.trim(),
      validate: (v: string) => /\S+@\S+\.\S+/.test(v.trim()) || 'Enter a valid email address',
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
      filter: (v: string) => v.trim(),
      validate: (v: string) => {
        const trimmed = v.trim();
        if (!trimmed) return 'Client ID is required';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
          return 'Client ID must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)';
        }
        return true;
      },
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

  const resolvedSecret = fleet_api_key.length > 0 ? fleet_api_key : current!.fleet_api_key;

  let refresh_token: string;
  const credentialsChanged =
    fleet_client_id.trim() !== current?.fleet_client_id ||
    fleet_api_key.length > 0;

  if (current?.refresh_token && !credentialsChanged) {
    const { keepToken } = await inquirer.prompt<{ keepToken: boolean }>([
      {
        type: 'confirm',
        name: 'keepToken',
        message: 'Keep existing Tesla authorization (refresh token)?',
        default: true,
      },
    ]);
    if (keepToken) {
      refresh_token = current.refresh_token;
    } else {
      refresh_token = await runTeslaOAuth(fleet_client_id.trim(), resolvedSecret);
    }
  } else {
    refresh_token = await runTeslaOAuth(fleet_client_id.trim(), resolvedSecret);
  }

  const { email, vin } = await inquirer.prompt<{ email: string; vin: string }>([
    {
      type: 'input',
      name: 'email',
      message: 'Tesla account email (optional):',
      default: current?.email ?? '',
      filter: (v: string) => v.trim(),
      validate: (v: string) => {
        const trimmed = v.trim();
        if (!trimmed) return true;
        return /\S+@\S+\.\S+/.test(trimmed) || 'Enter a valid email address';
      },
    },
    {
      type: 'input',
      name: 'vin',
      message: 'Vehicle VIN (leave blank to use the first vehicle on the account):',
      default: current?.vin ?? '',
      filter: (v: string) => v.trim().toUpperCase(),
      validate: (v: string) => {
        const trimmed = v.trim();
        if (!trimmed) return true;
        if (trimmed.length !== 17) return `VIN must be exactly 17 characters (got ${trimmed.length})`;
        if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(trimmed)) return 'VIN must contain only letters (A-Z, no I/O/Q) and digits';
        return true;
      },
    },
  ]);

  const tesla: AppConfig['tesla'] = {
    fleet_client_id: fleet_client_id.trim(),
    fleet_api_key: resolvedSecret,
    refresh_token,
  };
  if (email) tesla.email = email.trim();
  if (vin) tesla.vin = vin.trim().toUpperCase();
  return tesla;
}

async function runTeslaOAuth(clientId: string, clientSecret: string): Promise<string> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL(`${TESLA_AUTH_URL}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', TESLA_REDIRECT_URI);
  authUrl.searchParams.set('scope', TESLA_SCOPE);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('\n  ── Tesla Authorization ──────────────────────────────────────────────');
  console.log('  Open this URL in your browser to authorize access to your Tesla:\n');
  console.log(`  ${authUrl.toString()}\n`);
  console.log('  After approving, you will land on a page that shows your authorization');
  console.log('  code. Copy the full URL from the browser address bar and paste it below.');
  console.log('  ─────────────────────────────────────────────────────────────────────\n');

  const { redirectUrl } = await inquirer.prompt<{ redirectUrl: string }>([
    {
      type: 'input',
      name: 'redirectUrl',
      message: 'Paste the redirect URL here:',
      filter: (v: string) => v.trim(),
      validate: (v: string) => {
        try {
          const url = new URL(v.trim());
          if (!url.searchParams.has('code')) return 'No authorization code found — did you copy the full URL from the address bar?';
          return true;
        } catch {
          return 'Enter a valid URL starting with http://localhost';
        }
      },
    },
  ]);

  const code = new URL(redirectUrl).searchParams.get('code')!;

  console.log('\n  Exchanging authorization code for refresh token…');

  const tokenRes = await fetch(`${TESLA_AUTH_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: TESLA_REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`Tesla token exchange failed: ${tokenRes.status} ${tokenRes.statusText}${body ? ` — ${body}` : ''}`);
  }

  const data = (await tokenRes.json()) as { refresh_token: string };
  if (!data.refresh_token) {
    throw new Error('Tesla did not return a refresh token — make sure the offline_access scope is enabled on your application');
  }

  console.log('  Tesla authorization successful.\n');
  return data.refresh_token;
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
