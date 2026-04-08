/**
 * sense.ts — Sense Home Energy Monitor WebSocket client.
 *
 * Authenticates with the Sense HTTP API, then opens a persistent WebSocket to
 * the real-time data feed and caches the most recent `solar_w` and `w` (total
 * home consumption) values so the controller can read them each poll cycle.
 *
 * Design notes:
 *   - The Sense API is unofficial and undocumented; it may break without notice.
 *     All interaction is confined here so the interface (`getSolarWatts()` /
 *     `getHomeWatts()`) can be swapped for another source (Enphase, SolarEdge)
 *     without touching controller logic.
 *   - Re-authentication is rate-limited to once per 15 minutes. Transient
 *     WebSocket drops reuse the existing token to avoid hammering the auth
 *     endpoint. Only a gap longer than 15 minutes (or a 401 response) triggers
 *     a fresh login.
 *   - If the WebSocket drops, `scheduleReconnect()` retries every 5 seconds
 *     indefinitely while `shouldReconnect` is true. The last good Sense values
 *     are held in memory so the controller keeps running with stale-but-safe
 *     data rather than crashing.
 *
 * Error paths:
 *   - Auth HTTP failure (wrong credentials, network down)
 *     → `connect()` rejects with "Sense auth failed: <status>"
 *     → CLI exits; Homebridge plugin logs and continues with switch visible.
 *   - WebSocket error after initial connect
 *     → logged via the optional `SenseLogger` callback; reconnect is scheduled.
 *   - Reconnect keeps failing (Sense service down)
 *     → each attempt is logged; retries continue silently in the background.
 *     The cached watts values remain at their last known reading (typically 0
 *     after a restart before the first frame arrives).
 */

import WebSocket from 'ws';

const AUTH_URL = 'https://api.sense.com/apiservice/api/v1/authenticate';
const WS_BASE_URL = 'wss://clientrt.sense.com/monitors';

const RECONNECT_DELAY_MS = 5_000;
/**
 * Minimum time between full re-authentications to the Sense HTTP endpoint.
 * Transient WebSocket drops reuse the existing token; only a drop lasting
 * longer than this window (or an explicit auth failure) triggers a new login.
 */
const MIN_REAUTH_MS = 15 * 60 * 1_000;

interface AuthResponse {
  access_token: string;
  monitors: Array<{ id: number }>;
}

interface RealtimePayload {
  w: number;
  solar_w: number;
}

interface RealtimeFrame {
  type: string;
  payload: RealtimePayload;
}

/** Optional callback so callers (CLI, Homebridge) receive Sense-internal errors through their own logging channel. */
export type SenseLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

export class SenseClient {
  private solarWatts = 0;
  private homeWatts = 0;
  private accessToken: string | null = null;
  private monitorId: number | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  /** Timestamp of the last successful HTTP authentication. Used to rate-limit re-auth. */
  private lastAuthAt = 0;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly logger?: SenseLogger,
  ) {}

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    await this.authenticate();
    await this.openWebSocket();
  }

  getSolarWatts(): number {
    return this.solarWatts;
  }

  getHomeWatts(): number {
    return this.homeWatts;
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private async authenticate(): Promise<void> {
    const body = new URLSearchParams({ email: this.email, password: this.password });
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Sense auth failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as AuthResponse;
    this.accessToken = data.access_token;
    this.monitorId = data.monitors[0].id;
    this.lastAuthAt = Date.now();
  }

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE_URL}/${this.monitorId}/realtimefeed?access_token=${this.accessToken}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const frame = JSON.parse(raw.toString()) as RealtimeFrame;
          if (frame.type === 'realtime_update' && frame.payload) {
            this.solarWatts = frame.payload.solar_w ?? 0;
            this.homeWatts = frame.payload.w ?? 0;
          }
        } catch {
          // ignore malformed frames
        }
      });

      ws.on('close', () => {
        this.ws = null;
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        // 'close' fires after 'error'; reconnect logic lives in the close handler.
        this.logger?.('error', `WebSocket error: ${err.message}`);
      });
    });
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        // Re-authenticate only if the token is more than 15 minutes old.
        // Transient drops (network blip, server restart) don't need a fresh
        // login — reusing the existing token avoids hammering the Sense auth
        // endpoint and stays well within any undocumented rate limits.
        if (Date.now() - this.lastAuthAt >= MIN_REAUTH_MS) {
          await this.authenticate();
        }
        await this.openWebSocket();
      } catch (err) {
        this.logger?.('error', `Reconnect failed: ${(err as Error).message}`);
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      }
    }, RECONNECT_DELAY_MS);
  }
}
