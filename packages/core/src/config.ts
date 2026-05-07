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
    redirect_uri?: string;
    email?: string;
    vin?: string;
  };
  charging: {
    min_amps: number;
    max_amps: number;
    poll_interval_seconds: number;
    stop_when_insufficient: boolean;
    adaptive_polling?: {
      enabled: boolean;
      stable_after_minutes: number;
      stable_interval_seconds: number;
      change_threshold_watts: number;
    };
  };
  home?: {
    address?: string;
    latitude?: number;
    longitude?: number;
    timezone?: string;
    radius_meters?: number;
    geocoded_address?: string;
    address_last_resolved?: string;
  };
  automation?: {
    daily_wake_enabled: boolean;
    wake_after_sunrise_minutes: number;
    sleep_after_insufficient_minutes: number | null;
    power_expensive_start_time?: string | null;
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
    const { min_amps, max_amps, poll_interval_seconds, stop_when_insufficient, adaptive_polling } = config.charging;

    requireInt(min_amps, 'charging.min_amps', 1, 48, errors);
    requireInt(max_amps, 'charging.max_amps', 1, 48, errors);

    if (typeof min_amps === 'number' && typeof max_amps === 'number' && max_amps < min_amps) {
      errors.push(`charging.max_amps (${max_amps}) must be >= charging.min_amps (${min_amps})`);
    }

    requireInt(poll_interval_seconds, 'charging.poll_interval_seconds', 10, Infinity, errors);

    if (typeof stop_when_insufficient !== 'boolean') {
      errors.push('charging.stop_when_insufficient must be a boolean (true or false)');
    }

    if (adaptive_polling !== undefined) {
      if (typeof adaptive_polling.enabled !== 'boolean') {
        errors.push('charging.adaptive_polling.enabled must be a boolean (true or false)');
      }
      requireInt(adaptive_polling.stable_after_minutes, 'charging.adaptive_polling.stable_after_minutes', 1, 24 * 60, errors);
      requireInt(adaptive_polling.stable_interval_seconds, 'charging.adaptive_polling.stable_interval_seconds', 10, 24 * 60 * 60, errors);
      requireInt(adaptive_polling.change_threshold_watts, 'charging.adaptive_polling.change_threshold_watts', 0, 10_000, errors);

      if (
        typeof poll_interval_seconds === 'number' &&
        typeof adaptive_polling.stable_interval_seconds === 'number' &&
        adaptive_polling.stable_interval_seconds < poll_interval_seconds
      ) {
        errors.push(
          'charging.adaptive_polling.stable_interval_seconds must be >= charging.poll_interval_seconds',
        );
      }
    }
  }

  if (config?.homebridge !== undefined) {
    const val = config.homebridge.auto_off_after_no_solar_minutes;
    if (val !== null && (typeof val !== 'number' || val < 1)) {
      errors.push('homebridge.auto_off_after_no_solar_minutes must be a positive number or null');
    }
  }

  if (config?.home !== undefined) {
    if (config.home.address !== undefined && typeof config.home.address !== 'string') {
      errors.push('home.address must be a string when provided');
    }
    if (config.home.geocoded_address !== undefined && typeof config.home.geocoded_address !== 'string') {
      errors.push('home.geocoded_address must be a string when provided');
    }
    if (config.home.address_last_resolved !== undefined && typeof config.home.address_last_resolved !== 'string') {
      errors.push('home.address_last_resolved must be a string when provided');
    }
    if (config.home.latitude !== undefined) {
      requireNumber(config.home.latitude, 'home.latitude', -90, 90, errors);
    }
    if (config.home.longitude !== undefined) {
      requireNumber(config.home.longitude, 'home.longitude', -180, 180, errors);
    }
    if (config.home.timezone !== undefined) {
      requireString(config.home.timezone, 'home.timezone', errors);
    }
    if (config.home.radius_meters !== undefined) {
      requireInt(config.home.radius_meters, 'home.radius_meters', 10, 10_000, errors);
    }
  }

  if (config?.automation !== undefined) {
    const {
      daily_wake_enabled,
      wake_after_sunrise_minutes,
      sleep_after_insufficient_minutes,
      power_expensive_start_time,
    } = config.automation;

    if (typeof daily_wake_enabled !== 'boolean') {
      errors.push('automation.daily_wake_enabled must be a boolean (true or false)');
    }
    requireInt(wake_after_sunrise_minutes, 'automation.wake_after_sunrise_minutes', 0, 24 * 60, errors);
    if (
      sleep_after_insufficient_minutes !== null &&
      (typeof sleep_after_insufficient_minutes !== 'number' ||
        !Number.isInteger(sleep_after_insufficient_minutes) ||
        sleep_after_insufficient_minutes < 1)
    ) {
      errors.push('automation.sleep_after_insufficient_minutes must be a positive whole number or null');
    }
    if (
      power_expensive_start_time !== undefined &&
      power_expensive_start_time !== null &&
      !isClockTime(power_expensive_start_time)
    ) {
      errors.push('automation.power_expensive_start_time must be blank/null or HH:MM in 24-hour time');
    }

    if (daily_wake_enabled) {
      const hasCoords = config.home?.latitude !== undefined && config.home?.longitude !== undefined;
      const hasAddress = typeof config.home?.address === 'string' && config.home.address.trim() !== '';
      if (!hasCoords && !hasAddress) {
        errors.push('home.latitude/home.longitude or home.address is required when scheduled automation is enabled');
      }
      if (config.home?.timezone === undefined && !hasAddress) {
        errors.push('home.timezone is required when scheduled automation is enabled without home.address');
      }
    }

    if (power_expensive_start_time) {
      const hasAddress = typeof config.home?.address === 'string' && config.home.address.trim() !== '';
      if (config.home?.timezone === undefined && !hasAddress) {
        errors.push('home.timezone or home.address is required when automation.power_expensive_start_time is set');
      }
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

function requireNumber(value: unknown, field: string, min: number, max: number, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${field} must be a number`);
    return;
  }
  if (value < min || value > max) {
    errors.push(`${field} must be between ${min} and ${max} (got ${value})`);
  }
}

function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}
