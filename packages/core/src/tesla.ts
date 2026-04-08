/**
 * tesla.ts — Tesla vehicle API client (Owner's API + Fleet API).
 *
 * Implements the commands the controller needs: authenticate, get vehicle,
 * wake vehicle, set charging amps, start charging, stop charging.
 *
 * Two authentication strategies share the same public interface:
 *   owners_api  — OAuth2 refresh_token grant against auth.tesla.com.
 *                 The refresh token may rotate; the client stores the latest
 *                 copy in memory so subsequent refreshes use the current token.
 *   fleet_api   — OAuth2 client_credentials grant. No refresh token is issued;
 *                 the client re-runs the grant when the access token expires.
 *
 * Token lifecycle:
 *   - `ensureToken()` is called before every API request.
 *   - Access tokens are considered expired 60 s before their actual expiry to
 *     avoid edge-case failures caused by clock skew or slow requests.
 *   - Tokens are stored in memory only; there is no disk cache. A Homebridge
 *     restart or process crash will trigger a fresh authentication on the next
 *     request, which is acceptable given the token TTL (typically 8 hours).
 *
 * Wake-up handling:
 *   - Vehicles go to sleep when idle. Before any command, `wakeVehicle()` must
 *     be called. It polls the vehicle state every 2 s for up to 30 s.
 *   - If the vehicle does not come online within 30 s, the method throws. The
 *     controller catches this in `tick()`, logs a warning, and tries again on
 *     the next poll cycle.
 *
 * Error paths:
 *   - Auth failure (bad token/credentials, network down)
 *     → throws "Tesla Owner's/Fleet API auth failed: <status>"
 *     → propagates to controller `tick()` which logs it and retries next cycle.
 *   - Vehicle not found on account
 *     → throws "Vehicle with VIN X not found" or "No vehicles on account"
 *   - Wake timeout (vehicle unresponsive for 30 s)
 *     → throws "Vehicle <id> did not come online within 30s"
 *   - Command rejected by vehicle (e.g. already charging, charge limit reached)
 *     → `assertResult()` throws "Tesla command <cmd> rejected: <reason>"
 *   - Any HTTP error from the API
 *     → throws "Tesla GET/POST <path> failed: <status>"
 */

import { type AppConfig } from './config.js';

// ---- Endpoints & constants --------------------------------------------------

const AUTH_URL = 'https://auth.tesla.com/oauth2/v3/token';

const OWNERS_API_BASE = 'https://owner-api.teslamotors.com';

/**
 * North-America Fleet API base URL.
 * Also used as the `audience` claim in the client_credentials token request.
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
  /** Present for Owner's API refresh_token grants; absent for client_credentials. */
  refresh_token?: string;
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
  /**
   * Mutable copy of the Owner's API refresh token.
   * Kept separate from the config object so token rotation is safe without
   * mutating the caller's config.
   */
  private refreshToken: string;

  /**
   * @param teslaConfig The `tesla` block from AppConfig.
   *   - owners_api mode: `password` must be the OAuth2 refresh token.
   *   - fleet_api mode: `fleet_client_id` + `fleet_api_key` must be set.
   */
  constructor(private readonly teslaConfig: AppConfig['tesla']) {
    this.refreshToken = teslaConfig.password ?? '';
  }

  /**
   * Acquire a fresh access token.
   * Owner's API: refresh_token grant (token may rotate).
   * Fleet API:   client_credentials grant (no refresh token issued).
   */
  async authenticate(): Promise<void> {
    if (this.teslaConfig.mode === 'fleet_api') {
      await this.authenticateFleetApi();
    } else {
      await this.authenticateOwnersApi();
    }
  }

  /** Return the first vehicle on the account, or the one matching `vin`. */
  async getVehicle(vin?: string): Promise<Vehicle> {
    await this.ensureToken();
    const { response } = await this.get<VehicleData[]>('/api/1/vehicles');
    const match = vin ? response.find((v) => v.vin === vin) : response[0];
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

  // ---- Auth strategies -------------------------------------------------------

  private async authenticateOwnersApi(): Promise<void> {
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: 'ownerapi',
        refresh_token: this.refreshToken,
        scope: 'openid email offline_access',
      }),
    });
    if (!res.ok) {
      throw new Error(`Tesla Owner's API auth failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1_000;
    // Store the rotated refresh token for the next auth cycle.
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
  }

  private async authenticateFleetApi(): Promise<void> {
    const { fleet_client_id, fleet_api_key } = this.teslaConfig;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: fleet_client_id!,
      client_secret: fleet_api_key!,
      scope: FLEET_SCOPE,
      // Tesla's auth server requires the target audience for Fleet API tokens.
      audience: FLEET_API_BASE,
    });
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Tesla Fleet API auth failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1_000;
    // client_credentials grants never return a refresh_token — nothing to store.
  }

  // ---- HTTP helpers ----------------------------------------------------------

  private get apiBase(): string {
    return this.teslaConfig.mode === 'fleet_api' ? FLEET_API_BASE : OWNERS_API_BASE;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      await this.authenticate();
    }
  }

  private async get<T>(path: string): Promise<ApiEnvelope<T>> {
    const res = await fetch(`${this.apiBase}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Tesla GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<ApiEnvelope<T>>;
  }

  private async post<T>(path: string, body: object): Promise<ApiEnvelope<T>> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Tesla POST ${path} failed: ${res.status} ${res.statusText}`);
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
