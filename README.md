# EV Solar Charger

Automatically charges your Tesla using only surplus solar power. It reads your current solar production and home consumption from a Sense Energy Monitor in real time, then adjusts your Tesla's charging rate every minute so the car draws only what the panels are generating beyond your home's needs. When clouds roll in it dials the amps down; when production recovers it dials back up; if surplus drops below your configured floor it can stop the session entirely and restart it when the sun returns.

There is no cloud service or subscription involved. The program runs on your own machine and talks directly to Sense's WebSocket feed and the Tesla API.

---

## How it works

1. **Sense** streams your solar and home watt readings over a WebSocket connection that stays open as long as the program is running.
2. Every poll cycle (default: 60 seconds) the controller subtracts your base home load from solar production to find the surplus available for charging.
3. That surplus is converted to amps (`surplus ÷ 240 V`) and clamped to your configured min/max.
4. If the car is asleep it is woken before the first command. If it is already charging, only the amp setpoint is adjusted — no stop/start overhead.
5. Everything is logged to the terminal with timestamps so you can see exactly what is happening each cycle.

---

## Requirements

- **Node.js 18 or later** — [nodejs.org/en/download](https://nodejs.org/en/download)
- **Sense Energy Monitor** with solar configured in the Sense app
- **Tesla** with a home charger (EVSE) connected
- A **Tesla account credential** — which kind depends on your vehicle; see [Tesla API setup](#tesla-api-setup) at the bottom of this page

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/ianrajczi/homebridge-sense-tesla-ev-optimization.git
cd homebridge-sense-tesla-ev-optimization

# 2. Install dependencies
npm install

# 3. Build the packages
npm run build --workspaces
```

---

## First-time setup

Run the interactive wizard once. It will ask for your Sense credentials, Tesla credentials, and charging preferences, then write a `config.yaml` file.

```bash
node packages/cli/dist/index.js
```

Because no `config.yaml` exists yet, the program will detect that and launch the setup wizard automatically. Answer each prompt:

```
EV Solar Charger — First-run Setup
────────────────────────────────────
This wizard creates your config.yaml.
Secrets are stored in plain text; restrict file permissions if needed.

Where should the config file be saved? (./config.yaml)

  Sense Energy Monitor
  ─────────────────────
Sense account email: you@example.com
Sense account password: ********

  Tesla
  ─────
API mode: (Use arrow keys)
❯ Owner's API  (personal use — OAuth2 refresh token)
  Fleet API    (third-party app — fleet API key)

Tesla OAuth2 refresh token: ********
Tesla account email (optional):
Vehicle VIN (leave blank to use the first vehicle on the account):

  Charging Settings
  ──────────────────
Minimum charging amps (start/stop threshold): (5)
Maximum charging amps: (32)
Sense polling interval (seconds): (60)
Stop charging when surplus drops below minimum amps? (Y/n)
```

After confirming the summary, `config.yaml` is written with permissions `600` (owner read/write only).

### Getting your Tesla credentials

Which credentials you need depends on your vehicle model and year. See [Tesla API setup](#tesla-api-setup) at the bottom of this page for the full guide — it covers which path fits your car and walks through both the Owner's API (refresh token) and Fleet API registration step by step.

---

## Starting the charger

Once `config.yaml` exists, start the program:

```bash
node packages/cli/dist/index.js
```

You should see output like this within a few seconds:

```
[2026-04-08 14:31:00.000] [INFO ] Loaded config from /your/path/config.yaml
[2026-04-08 14:31:00.001] [INFO ] Connecting to Sense…
[2026-04-08 14:31:01.843] [INFO ] Sense connected
[2026-04-08 14:31:01.844] [INFO ] Controller started
[2026-04-08 14:31:01.845] [INFO ] Using vehicle: Model 3 (5YJ3E1EA…)
[2026-04-08 14:31:01.846] [INFO ] Solar 4820W · Home 640W · Available 4180W · Raw target 17.4A
[2026-04-08 14:31:01.847] [INFO ] Waking Model 3…
[2026-04-08 14:31:18.002] [INFO ] Charging started at 17A
[2026-04-08 14:31:18.003] [INFO ] --- charging started at 17A ---
```

Leave the terminal window open (or run it as a background service — see below). The program adjusts the charge rate automatically every poll cycle for as long as it runs.

---

## Stopping the charger

Press **Ctrl + C** in the terminal. The program catches the signal, stops the polling loop, closes the Sense WebSocket cleanly, and exits. The car continues charging at whatever amp setpoint was last commanded — it does not stop charging when the program exits.

```
^C
[2026-04-08 15:44:07.112] [INFO ] SIGINT received — shutting down
```

To also stop the car from charging, use the Tesla app or tap the charge port button before stopping the program.

---

## The daily workflow (plug in and go)

**When you plug in the car and want solar-optimised charging:**

```bash
node packages/cli/dist/index.js
```

Leave it running. Charging adjusts itself throughout the day.

**When you want to unplug / stop for the day:**

1. Press Ctrl + C (or `kill` the process if it is running in the background).
2. Unplug the car as normal.

You do not need to re-run setup. `config.yaml` is reused every time. Only run the setup wizard again if you change your Sense or Tesla credentials.

---

## Keeping it running in the background (Mac)

If you want the charger to start automatically when you plug the car in — without keeping a terminal open — you can run it as a macOS launchd service.

### 1. Create the plist file

Create the file `~/Library/LaunchAgents/com.evsolarcharger.plist` with the following content. Replace the two paths with the actual locations on your machine.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.evsolarcharger</string>

  <key>ProgramArguments</key>
  <array>
    <!-- Replace with the output of: which node -->
    <string>/usr/local/bin/node</string>
    <!-- Replace with the full path to this repo -->
    <string>/Users/you/homebridge-sense-tesla-ev-optimization/packages/cli/dist/index.js</string>
  </array>

  <!-- Where to write stdout/stderr logs -->
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/ev-solar-charger.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/ev-solar-charger.log</string>

  <!-- Set the working directory so config.yaml is found -->
  <key>WorkingDirectory</key>
  <string>/Users/you/homebridge-sense-tesla-ev-optimization</string>

  <!-- Start automatically when you log in -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Restart automatically if it crashes -->
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

### 2. Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.evsolarcharger.plist
```

The program starts immediately and will restart automatically if it crashes. Logs are written to `~/Library/Logs/ev-solar-charger.log`.

### 3. Check the logs

```bash
tail -f ~/Library/Logs/ev-solar-charger.log
```

### 4. Stop the service

```bash
launchctl unload ~/Library/LaunchAgents/com.evsolarcharger.plist
```

This stops the process and prevents it from restarting on the next login. To start it again later:

```bash
launchctl load ~/Library/LaunchAgents/com.evsolarcharger.plist
```

### Finding the right paths

```bash
# Find your node binary path (paste into ProgramArguments above)
which node

# Find the repo path (confirm it matches what you cloned)
pwd   # run this from inside the repo directory
```

---

## Configuration reference

`config.yaml` is the only file you need to edit. A fully commented example is in [`config.example.yaml`](config.example.yaml).

| Field | Required | Description |
|---|---|---|
| `sense.email` | Yes | Sense account email |
| `sense.password` | Yes | Sense account password |
| `tesla.mode` | Yes | `owners_api` or `fleet_api` |
| `tesla.password` | owners_api | OAuth2 refresh token |
| `tesla.fleet_client_id` | fleet_api | App client ID from developer.tesla.com |
| `tesla.fleet_api_key` | fleet_api | App client secret from developer.tesla.com |
| `tesla.vin` | No | VIN of the vehicle to charge (defaults to first on account) |
| `charging.min_amps` | Yes | Minimum charging rate (1–48). Session starts only when surplus supports this. |
| `charging.max_amps` | Yes | Maximum charging rate (1–48). Must be ≥ min_amps. |
| `charging.poll_interval_seconds` | Yes | How often to read Sense and adjust amps (≥ 10). |
| `charging.stop_when_insufficient` | Yes | `true` stops the session when surplus drops below min_amps. `false` keeps charging at min_amps. |

The config path defaults to `./config.yaml` (relative to where you run the command). Override it with the `EV_CONFIG_PATH` environment variable:

```bash
EV_CONFIG_PATH=/etc/ev-charger/config.yaml node packages/cli/dist/index.js
```

---

## Troubleshooting

**"No config found" on every run**
The program looks for `config.yaml` in the current working directory. Make sure you are running the command from inside the repo folder, or set `EV_CONFIG_PATH` to the full path of your config file.

**Sense connects but solar always reads 0 W**
Sense takes a few seconds after connecting to start streaming data. If readings stay at 0, confirm that solar is configured and active in the Sense app.

**Tesla wake-up times out**
The car has 30 seconds to respond. If it consistently fails, check that the car has a cellular or Wi-Fi connection and that the Tesla app can reach it.

**"Sense auth failed: 401"**
Your Sense email or password is wrong. Re-run setup (`rm config.yaml && node packages/cli/dist/index.js`) to enter them again.

**"Tesla Owner's API auth failed: 401"**
Your refresh token has expired or been revoked (this happens if you change your Tesla password). Get a new token using the Auth app and update `tesla.password` in `config.yaml`.

---

## Tesla API setup

Tesla has two APIs, and which one works for your car depends on when it was built. This section explains the difference, helps you pick the right path, and walks through the setup for each.

---

### Which path is right for your vehicle?

| Vehicle | Recommended mode | Notes |
|---|---|---|
| Model 3 (2017–2023, original body) | `owners_api` | Simplest path. Refresh token is all you need. |
| Model Y (2020–2022) | `owners_api` | Same as above. |
| Model S / Model X (pre-2021) | `owners_api` | Works well. |
| Model 3 Highland (2024+) | `fleet_api` | New architecture; Owner's API commands may be unreliable. |
| Model Y (2023+, new arch.) | `fleet_api` | Depends on build date — try `owners_api` first. |
| Model S Plaid / Model X Plaid (2021+) | `fleet_api` | New architecture; see note below. |
| Cybertruck (all) | `fleet_api` | Fleet API required. |

**Not sure which you have?** Open the Tesla app → tap your car → tap the three-dot menu → About. If the software version shows "2023.x" or later on a Model S/X, or your Model 3/Y was purchased in 2024 or later, assume you need `fleet_api`. If in doubt, try `owners_api` first — the worst that can happen is a 401 error and you switch modes.

> **Note on newer vehicles and signed commands.** Tesla's 2021+ vehicle architectures (Plaid models, Cybertruck, 2024+ Model 3 Highland) use a Vehicle Command Protocol that requires vehicle commands to be cryptographically signed by a registered key pair. This signing layer sits on top of the Fleet API and requires additional infrastructure (a local command proxy or Tesla's official mobile SDK). **This program does not currently implement command signing.** If you have one of these newer vehicles and find that `fleet_api` mode authenticates successfully but charging commands fail with a "unsigned commands not supported" style error, see [Tesla's vehicle command proxy](https://github.com/teslamotors/vehicle-command) on GitHub for the additional setup steps. For most users with pre-2024 vehicles, `owners_api` works without any of this.

---

### Option A — Owner's API (simpler, personal use)

The Owner's API is Tesla's unofficial API originally built for the official Tesla mobile app. It is not publicly documented by Tesla but has been reverse-engineered and is widely used for personal projects. It works by exchanging a refresh token for short-lived access tokens.

**Who should use this:** Anyone with a pre-2024 Tesla who wants the simplest possible setup.

#### Step 1 — Get a refresh token

Tesla's login uses a browser-based OAuth2 PKCE flow that is awkward to do manually. The easiest approach is a small app that does it for you:

**iOS / Android — Auth app for Tesla**
1. Search for **"Auth app for Tesla"** in the App Store or Google Play Store (it is a grey icon with a T).
2. Open the app and tap **Sign in with Tesla**.
3. Log in with your Tesla account email and password. If you have MFA enabled, complete that step too.
4. After signing in, tap **Get Token**.
5. Copy the **Refresh Token** — it is a long string starting with `eyJ...` or similar. It is only shown once so copy it before leaving the screen.

**Mac / Windows / Linux — tesla-auth CLI**
1. Install it: `pip install tesla-auth` (requires Python 3)
2. Run: `tesla-auth`
3. A browser window opens to Tesla's login page. Log in normally.
4. After authenticating, the CLI prints your refresh token to the terminal.

#### Step 2 — Configure

When the setup wizard asks **"API mode"**, choose `Owner's API`. When it asks for the **OAuth2 refresh token**, paste the token you just copied.

In `config.yaml` this looks like:

```yaml
tesla:
  mode: "owners_api"
  password: "your-long-refresh-token-here"
```

#### Notes

- The token does not expire on a fixed schedule. It is valid until you change your Tesla password, sign out of all devices in the Tesla app, or explicitly revoke it.
- Each time the program authenticates it may receive a new refresh token. It stores the latest one in memory and uses it for the next auth cycle. If you restart the program it re-reads from `config.yaml`, which still has your original token — this is fine as long as you have not revoked it.
- If you change your Tesla password, update `tesla.password` in `config.yaml` with a freshly obtained token.

---

### Option B — Fleet API (official, required for newer vehicles)

The Tesla Fleet API is the officially supported API for third-party applications. It uses standard OAuth2 `client_credentials` with credentials you register on Tesla's developer portal. Setup takes about 15 minutes.

**Who should use this:** Anyone with a 2024+ Model 3 or Cybertruck, Plaid model owners who want official API support, or anyone who prefers to use a supported API.

#### Step 1 — Create a Tesla developer account

1. Go to [developer.tesla.com](https://developer.tesla.com) and sign in with your Tesla account.
2. Accept the developer terms if prompted.
3. Tesla requires a one-time registration fee for API access. Follow the prompts on the developer portal to complete that step.

#### Step 2 — Register an application

1. In the developer portal, click **Create Application**.
2. Fill in the required fields. For personal use these can be anything descriptive:
   - **Application name:** e.g. `My Solar Charger`
   - **Description:** e.g. `Adjusts charging rate based on solar surplus`
   - **Allowed origin:** `http://localhost` (required field; not actually used for `client_credentials` flow)
3. Under **Scopes**, enable:
   - `vehicle_device_data` — needed to read vehicle state and list vehicles
   - `vehicle_cmds` — needed to send commands (wake, start/stop charging)
   - `vehicle_charging_cmds` — needed specifically for charging commands (set amps, start, stop)
4. Click **Create**. Tesla will show you a **Client ID** and **Client Secret** — copy both immediately. The client secret is shown only once.

#### Step 3 — Configure

When the setup wizard asks **"API mode"**, choose `Fleet API`. It will then ask for:
- **Fleet API client ID** — paste the Client ID from the developer portal (looks like a UUID: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- **Fleet API client secret** — paste the Client Secret

In `config.yaml` this looks like:

```yaml
tesla:
  mode: "fleet_api"
  fleet_client_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  fleet_api_key: "your-client-secret-here"
```

#### Step 4 — Approve the application on your vehicle

Tesla's Fleet API requires a one-time approval from the vehicle owner before the application can send commands. Because this program is a personal app using `client_credentials`, you are both the developer and the owner.

1. In the Tesla app, go to **Security & Privacy → Third-Party App Access** (exact path varies by app version — look in Account or Settings).
2. Your registered application should appear. Tap it and tap **Allow**.

If it does not appear, you can also approve it programmatically via the Fleet API's `/api/1/partner_accounts` endpoint — see Tesla's Fleet API documentation at [developer.tesla.com/docs/fleet-api](https://developer.tesla.com/docs/fleet-api) for details.

#### Notes

- Fleet API access tokens are short-lived (typically 8 hours). The program re-authenticates automatically when the token nears expiry — no action needed.
- Unlike the Owner's API, Fleet API tokens are not rotated on use. Your `client_id` and `client_secret` are permanent credentials tied to your registered application.
- The Fleet API base URL used is North America (`fleet-api.prd.na.vn.cloud.tesla.com`). If your account is based in Europe or China, open `packages/core/src/tesla.ts` and update the `FLEET_API_BASE` constant to the appropriate regional URL listed in the comment at the top of that file.
