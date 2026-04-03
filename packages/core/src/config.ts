export interface AppConfig {
  sense: {
    email: string;
    password: string;
  };
  tesla: {
    mode: 'owners_api' | 'fleet_api';
    email?: string;
    password?: string;
    fleet_api_key?: string;
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

export function loadConfig(_filePath: string): AppConfig {
  throw new Error('Not yet implemented');
}

export function validateConfig(_config: AppConfig): void {
  throw new Error('Not yet implemented');
}
