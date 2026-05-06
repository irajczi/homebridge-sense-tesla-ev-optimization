import { type AppConfig } from './config.js';

// ---- Endpoints & constants --------------------------------------------------

const AUTH_URL = 'https://auth.tesla.com/oauth2/v3/token';

/**
 * North-America Fleet API base URL.
 * EU: https://fleet-api.prd.eu.vn.cloud.tesla.com
 * CN: https://fleet-api.prd.cn.vn.cloud.tesla.com
 */
const FLEET_API_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';

const FLEET_SCOPE = 'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds';

const WAKE_TIMEOUT_MS = 30_000;
const WAKE_POLL_MS = 2_000;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

// ---- Public interface -------------------------------------------------------

export interface Vehicle {
  id: string;
  vin: string;
  display_name: string;
  state: string;
}

// ---- Internal API shapes ----------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface VehicleData {
  id_s: string;
  vin: string;
  display_name: string;
  state: string;
}

interface ApiEnvelope<T> {
  response: T;
}

interface CommandResult {
  result: boolean;
  reason: string;
}

// ---- Client -----------------------------------------------------------------

export class TeslaClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly teslaConfig: AppConfig['tesla']) {}

  async authenticate(): Promise<void> {
    const { fleet_client_id, fleet_api_key } = this.teslaConfig;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: fleet_client_id,
      client_secret: fleet_api_key,
      scope: FLEET_SCOPE,
      audience: FLEET_API_BASE,
    });
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => '');
      throw new Error(`Tesla Fleet API auth failed: ${res.status} ${res.statusText}${resBody ? ` — ${resBody}` : ''}`);
    }
    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1_000;
  }

  /** Return the first vehicle on the account, or the one matching `vin`. */
  async getVehicle(vin?: string): Promise<Vehicle> {
    await this.ensureToken();
    const { response } = await this.get<VehicleData[]>('/api/1/vehicles');
    const match = vin
      ? response.find((v) => v.vin.toUpperCase() === vin.toUpperCase())
      : response[0];
    if (!match) {
      throw new Error(vin ? `Vehicle with VIN ${vin} not found` : 'No vehicles on account');
    }
    return toVehicle(match);
  }

  /**
   * Wake the vehicle and wait until it is online.
   * Polls every 2 s and throws after 30 s if still asleep.
   */
  async wakeVehicle(id: string): Promise<void> {
    await this.ensureToken();

    const { response: initial } = await this.post<VehicleData>(`/api/1/vehicles/${id}/wake_up`, {});
    if (initial.state === 'online') return;

    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(WAKE_POLL_MS);
      const { response } = await this.get<VehicleData>(`/api/1/vehicles/${id}`);
      if (response.state === 'online') return;
    }

    throw new Error(`Vehicle ${id} did not come online within ${WAKE_TIMEOUT_MS / 1_000}s`);
  }

  async setChargingAmps(id: string, amps: number): Promise<void> {
    await this.ensureToken();
    const data = await this.post<CommandResult>(
      `/api/1/vehicles/${id}/command/set_charging_amps`,
      { charging_amps: amps },
    );
    assertResult(data.response, 'set_charging_amps');
  }

  async startCharging(id: string): Promise<void> {
    await this.ensureToken();
    const data = await this.post<CommandResult>(`/api/1/vehicles/${id}/command/charge_start`, {});
    assertResult(data.response, 'charge_start');
  }

  async stopCharging(id: string): Promise<void> {
    await this.ensureToken();
    const data = await this.post<CommandResult>(`/api/1/vehicles/${id}/command/charge_stop`, {});
    assertResult(data.response, 'charge_stop');
  }

  // ---- HTTP helpers ----------------------------------------------------------

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      await this.authenticate();
    }
  }

  private async get<T>(path: string): Promise<ApiEnvelope<T>> {
    const res = await fetch(`${FLEET_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Tesla GET ${path} failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    return res.json() as Promise<ApiEnvelope<T>>;
  }

  private async post<T>(path: string, body: object): Promise<ApiEnvelope<T>> {
    const res = await fetch(`${FLEET_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => '');
      throw new Error(`Tesla POST ${path} failed: ${res.status} ${res.statusText}${resBody ? ` — ${resBody}` : ''}`);
    }
    return res.json() as Promise<ApiEnvelope<T>>;
  }
}

// ---- Utilities --------------------------------------------------------------

function toVehicle(v: VehicleData): Vehicle {
  return { id: v.id_s, vin: v.vin, display_name: v.display_name, state: v.state };
}

function assertResult(result: CommandResult, command: string): void {
  if (!result.result) {
    throw new Error(`Tesla command ${command} rejected: ${result.reason}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
