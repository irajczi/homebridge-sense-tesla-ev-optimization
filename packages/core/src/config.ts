import { readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';

// ---- Public interface -------------------------------------------------------

export interface AppConfig {
  sense: {
    email: string;
    password: string;
  };
  tesla: {
    fleet_client_id: string;
    fleet_api_key: string;
    refresh_token: string;
    email?: string;
    vin?: string;
  };
  charging: {
    min_amps: number;
    max_amps: number;
    poll_interval_seconds: number;
    stop_when_insufficient: boolean;
  };
  homebridge?: {
    auto_off_after_no_solar_minutes: number | null;
  };
}

// ---- Public functions -------------------------------------------------------

export function loadConfig(filePath: string): AppConfig {
  let raw: unknown;
  try {
    const text = readFileSync(filePath, 'utf8');
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`Cannot read config file "${filePath}": ${(err as Error).message}`);
  }

  const config = raw as AppConfig;
  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  const errors: string[] = [];

  requireString(config?.sense?.email, 'sense.email', errors);
  requireString(config?.sense?.password, 'sense.password', errors);

  requireString(config?.tesla?.fleet_client_id, 'tesla.fleet_client_id', errors);
  requireString(config?.tesla?.fleet_api_key, 'tesla.fleet_api_key', errors);
  requireString(config?.tesla?.refresh_token, 'tesla.refresh_token', errors);

  if (config?.charging == null) {
    errors.push('charging section is required');
  } else {
    const { min_amps, max_amps, poll_interval_seconds, stop_when_insufficient } = config.charging;

    requireInt(min_amps, 'charging.min_amps', 1, 48, errors);
    requireInt(max_amps, 'charging.max_amps', 1, 48, errors);

    if (typeof min_amps === 'number' && typeof max_amps === 'number' && max_amps < min_amps) {
      errors.push(`charging.max_amps (${max_amps}) must be >= charging.min_amps (${min_amps})`);
    }

    requireInt(poll_interval_seconds, 'charging.poll_interval_seconds', 10, Infinity, errors);

    if (typeof stop_when_insufficient !== 'boolean') {
      errors.push('charging.stop_when_insufficient must be a boolean (true or false)');
    }
  }

  if (config?.homebridge !== undefined) {
    const val = config.homebridge.auto_off_after_no_solar_minutes;
    if (val !== null && (typeof val !== 'number' || val < 1)) {
      errors.push('homebridge.auto_off_after_no_solar_minutes must be a positive number or null');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  • ${e}`).join('\n')}`);
  }
}

// ---- Validation helpers -----------------------------------------------------

function requireString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} is required and must be a non-empty string`);
  }
}

function requireInt(value: unknown, field: string, min: number, max: number, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${field} must be a number`);
    return;
  }
  if (!Number.isInteger(value)) {
    errors.push(`${field} must be a whole number (got ${value})`);
    return;
  }
  if (value < min || value > max) {
    const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
    errors.push(`${field} must be ${range} (got ${value})`);
  }
}
