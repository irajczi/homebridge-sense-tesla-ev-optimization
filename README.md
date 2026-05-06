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

### 1. Clone the repository

GitHub no longer accepts passwords for Git operations. Use one of these two methods:

**Option A — SSH (recommended if you use GitHub regularly)**

First, check whether you already have an SSH key:

```bash
ls ~/.ssh/id_ed25519.pub
```

If the file does not exist, generate one:

```bash
ssh-keygen -t ed25519 -C "your@email.com"
# Accept the default path; add a passphrase or leave blank
```

Then add the public key to GitHub: copy the output of `cat ~/.ssh/id_ed25519.pub`, go to **github.com → Settings → SSH and GPG keys → New SSH key**, paste it, and save.

Now clone:

```bash
git clone git@github.com:irajczi/homebridge-sense-tesla-ev-optimization.git
cd homebridge-sense-tesla-ev-optimization
```

**Option B — HTTPS with a Personal Access Token**

Go to **github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)** and generate a token with the `repo` scope. Then clone using your username and the token as the password:

```bash
git clone https://github.com/irajczi/homebridge-sense-tesla-ev-optimization.git
# Username: your GitHub username
# Password: paste the personal access token (not your account password)
cd homebridge-sense-tesla-ev-optimization
```

### 2. Install dependencies and build

```bash
npm install
npm run build
```

---

## First-time setup

Run the interactive wizard once. It will ask for your Sense credentials, Tesla Fleet API credentials, and charging preferences, then write a `config.yaml` file.

```bash
node packages/cli/dist/index.js
```

Because no `config.yaml` exists yet, the program detects that and runs the full setup wizard. See [Tesla Fleet API setup](#tesla-fleet-api-setup) at the bottom of this page to get your Fleet API credentials before running this.

After confirming the summary, `config.yaml` is written with permissions `600` (owner read/write only).

---

## Updating your configuration

If you need to change one section of your config without starting over — for example, updating your Tesla credentials without re-entering your Sense password — run the wizard again:

```bash
node packages/cli/dist/index.js
```

When a `config.yaml` already exists the wizard switches to update mode and shows a checklist:

```
  Found existing config: /your/path/config.yaml

? Which sections do you want to update?
 ◯ Sense credentials  (email / password)
 ◉ Tesla credentials  (Fleet API client ID + secret)
 ◯ Charging settings  (amps, interval, stop behaviour)
```

Select only the sections you want to change (space to toggle, enter to confirm). Fields you skip keep their current values — passwords included.

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
| `tesla.fleet_client_id` | Yes | App client ID (UUID) from developer.tesla.com |
| `tesla.fleet_api_key` | Yes | App client secret from developer.tesla.com |
| `tesla.refresh_token` | Yes | OAuth refresh token — obtained automatically by the setup wizard |
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

**"Tesla Fleet API auth failed: 401"**
Your client ID or client secret is wrong, or the application has been deleted from developer.tesla.com. Re-run setup (`node packages/cli/dist/index.js`) and re-enter your credentials.

---

## Tesla Fleet API setup

Tesla shut down the unofficial Owner's API in May 2025. All vehicles now require the official Fleet API. This is a one-time setup that takes about 20 minutes.

### Step 1 — Create a Tesla developer account

1. Go to [developer.tesla.com](https://developer.tesla.com) and sign in with your Tesla account.
2. Accept the developer terms and complete the one-time registration fee step.

### Step 2 — Register an application

1. In the developer portal, click **Create Application**.
2. Fill in the required fields (for personal use, any values work):
   - **Application name:** anything, e.g. `My Solar Charger`
   - **OAuth Grant Type:** select **Authorization Code** *(not Machine-to-Machine — personal vehicles require the Authorization Code flow)*
   - **Allowed origin / Redirect URI:** `http://localhost`
3. Under **Scopes**, enable:
   - `vehicle_device_data`
   - `vehicle_cmds`
   - `vehicle_charging_cmds`
   - `offline_access` *(required to get a refresh token)*
4. Click **Create**. Copy the **Client ID** (UUID) and **Client Secret** immediately — the secret is only shown once. Wrap them in single quotes when using in the terminal to avoid shell misinterpretation of special characters.

### Step 3 — Generate an EC key pair

Tesla requires you to host a public key so it can verify your application's identity during partner registration. Run this once on any machine:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
```

- `private-key.pem` — keep this secret, never commit it
- `public-key.pem` — this gets hosted publicly (safe to share)

### Step 4 — Host the public key at your GitHub Pages domain

Tesla looks up the public key at `https://YOUR-GITHUB-USERNAME.github.io/.well-known/appspecific/com.tesla.3p.public-key.pem`. This must be served from the **root** of your GitHub Pages domain (not a project sub-path).

The easiest way is a dedicated user Pages repository:

1. Create a new GitHub repository named exactly `YOUR-GITHUB-USERNAME.github.io`.
2. In that repo, create the file `.well-known/appspecific/com.tesla.3p.public-key.pem` and paste in the contents of your `public-key.pem`.
3. Go to the repo's **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main / (root)** → **Save**.
4. Wait ~2 minutes, then verify it's live:

```bash
curl https://YOUR-GITHUB-USERNAME.github.io/.well-known/appspecific/com.tesla.3p.public-key.pem
```

It should print your public key. If you get a 404, wait a minute and retry.

> **Note:** If you use a project Pages repo (e.g. this one), the key would be served at a sub-path and Tesla's verification would fail. Use the user Pages repo (`YOUR-GITHUB-USERNAME.github.io`) as shown above.

### Step 5 — Register as a Tesla partner (one-time API call)

Once the public key URL is responding, run these commands (replace with your actual credentials):

```bash
CLIENT_ID='your-client-id-uuid'
CLIENT_SECRET='your-client-secret'

TOKEN=$(curl -s -X POST https://auth.tesla.com/oauth2/v3/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "scope=openid vehicle_device_data vehicle_cmds vehicle_charging_cmds" \
  -d "audience=https://fleet-api.prd.na.vn.cloud.tesla.com" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s -X POST https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domain": "YOUR-GITHUB-USERNAME.github.io"}'
```

A successful response looks like `{"response":{"domain":"...","public_key":"..."},...}`. You do not need to save the token — it was only needed for this registration step. The app manages its own tokens automatically at runtime.

### Step 6 — Approve the app in the Tesla mobile app

1. In the Tesla app, go to **Account → Security & Privacy → Third-Party App Access**.
2. Your registered application should appear — tap it and tap **Allow**.

If the app does not appear immediately, complete Step 7 first (the setup wizard triggers the authorization flow), then check the Tesla app again.

### Step 7 — Run setup

```bash
node packages/cli/dist/index.js
```

Enter your **Fleet API client ID** and **client secret** when prompted. The wizard will then open a Tesla authorization URL in your browser. After you approve access:

1. Tesla redirects your browser to `http://localhost?code=…` — the page will show an error (there is no server listening there), which is expected.
2. Copy the full URL from the browser address bar and paste it back into the terminal.
3. The wizard exchanges the code for a **refresh token** and saves it to `config.yaml` automatically.

If you already ran setup before, the wizard shows a checklist — select **Tesla credentials** to update just that section without re-entering your Sense password.

### Notes

- Access tokens expire after ~8 hours. The program re-authenticates using the saved refresh token automatically.
- If Tesla rotates the refresh token during a session, the program updates `config.yaml` with the new token automatically.
- Your client ID and secret are permanent unless you regenerate them in the developer portal.
- **Region:** The default API URL is North America. If your Tesla account is in Europe or China, open [`packages/core/src/tesla.ts`](packages/core/src/tesla.ts) and update the `FLEET_API_BASE` constant to the correct regional URL shown in the comment at the top of that file.
- **Newer vehicles and signed commands:** Tesla's 2021+ architectures (Plaid, Cybertruck, 2024+ Model 3 Highland) require commands to be cryptographically signed. This program does not currently implement command signing. If Fleet API authenticates but charging commands fail with "unsigned commands not supported", see [Tesla's vehicle command proxy](https://github.com/teslamotors/vehicle-command). Pre-2021 vehicles are not affected.
