# Deploying to Linode

The bot runs unchanged on Cloudflare Workers and on a Linode box. This file
covers the Linode path. Nothing here needs to be done before you own the
server — the code is already portable, and until then it keeps running on
Cloudflare exactly as it does now.

**Before you start you need a domain name.** Meta will not deliver webhooks to
a bare IP address or a self-signed certificate. Point an A record at the
Linode's IP and let it propagate before step 5.

---

## 1. The server

A 1 GB Nanode is enough — the bot is I/O bound and holds no state locally.
Ubuntu 24.04 LTS.

```sh
adduser --system --group --home /opt/reistor-stylist reistor
apt update && apt install -y nginx git curl

# Node 20+ is required: --env-file and the global fetch/Request/Response the
# bot is written against both arrived in 20.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version   # expect v22 or newer
```

## 2. The code

```sh
cd /opt
git clone -b Azmeer https://github.com/reistor9-code/reistorstylist.git reistor-stylist
cd reistor-stylist
npm ci --omit=dev && npm install --no-save typescript @types/node @cloudflare/workers-types
npm run build:server
chown -R reistor:reistor /opt/reistor-stylist
```

`build:server` compiles TypeScript into `dist/`. `dist/server.js` is the entry
point.

## 3. Configuration

```sh
cp .env.example .env
nano .env          # fill in every value
chmod 600 .env
chown reistor:reistor .env
```

`.env` holds every secret on this box. It is in `.gitignore` and must never be
committed.

Two are worth calling out:

- **`APP_SECRET`** — without it, webhook signatures are not verified, and
  anyone who finds your URL can forge inbound messages and make the bot send
  WhatsApp messages on your bill. Set it before pointing a real number here.
- **`SUPABASE_SERVICE_KEY`** — bypasses row level security. It belongs on this
  server and nowhere else, least of all a browser.

## 4. The database

Once, in the Supabase SQL editor:

```
supabase/schema.sql
```

Safe to re-run. It creates the analytics tables and the `kv` table that
replaces Workers KV, which is what lets this box hold conversation state
without Cloudflare.

## 5. TLS

```sh
cp deploy/nginx.conf /etc/nginx/sites-available/reistor-stylist
# edit the two server_name lines to your hostname
ln -s /etc/nginx/sites-available/reistor-stylist /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d stylist.reistor.in
systemctl status certbot.timer    # renewal must be armed
```

> **Keep the CA trust store current.** Meta changed the webhook certificate
> authority on 31 March 2026. An out-of-date trust store makes webhooks stop
> arriving *silently* — no error, no bounce, nothing in your logs. On
> Cloudflare this was handled for you. Here it is yours:
> `apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades`

## 6. Start it

```sh
cp deploy/reistor-stylist.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now reistor-stylist
journalctl -u reistor-stylist -f
```

Expect:

```
[boot] Reistor AI Stylist listening on :8787
[boot] webhook   https://stylist.reistor.in/webhook
[boot] dashboard https://stylist.reistor.in/dashboard
[cron] next pull in NNN minutes
```

Any `[boot:warn]` lines name a feature that is silently disabled. Read them.

## 7. Point Meta at it

Meta App Dashboard → WhatsApp → Configuration → Edit:

| Field | Value |
| --- | --- |
| Callback URL | `https://stylist.reistor.in/webhook` |
| Verify token | your `VERIFY_TOKEN` |

Then **Manage** the webhook fields and subscribe to:

`messages`, `user_preferences`, `message_template_status_update`,
`message_template_quality_update`, `phone_number_quality_update`,
`account_alerts`, `account_update`

`messages` alone carries inbound texts **and** delivery receipts — the receipts
are where the `pricing` object lives, which is the only per-message cost data
Meta provides.

Finally, subscribe the WABA to the app:

```
https://stylist.reistor.in/admin/subscribe?token=<VERIFY_TOKEN>&waba=<WABA_ID>
```

---

## Verifying

```sh
curl https://stylist.reistor.in/health

# The Meta handshake — must echo back exactly "test123"
curl "https://stylist.reistor.in/webhook?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=test123"

# An unsigned POST must be refused with 403
curl -X POST https://stylist.reistor.in/webhook -d '{}'

# Run the nightly pull by hand rather than waiting for 02:30
curl "https://stylist.reistor.in/admin/pull?token=<VERIFY_TOKEN>"
```

Then message the business number and watch `journalctl -u reistor-stylist -f`.

## Updating

```sh
cd /opt/reistor-stylist
git pull
npm ci --omit=dev && npm install --no-save typescript @types/node @cloudflare/workers-types
npm run build:server
systemctl restart reistor-stylist
```

The service drains in-flight background work on SIGTERM, so a restart does not
lose analytics for messages already answered.

## Moving off Cloudflare

Both can run at once — they share one Supabase database, so no data is split.
The switch is one field:

1. Deploy here and confirm `/health` and the handshake.
2. Change Meta's Callback URL to the new domain.
3. Watch the journal for real traffic.
4. Only then `wrangler delete` the Worker.

Rolling back is the same field in the other direction. **The catalog and the
templates are bound to the WABA, not to the host, so neither needs touching.**

## What can go wrong

| Symptom | Cause |
| --- | --- |
| Webhooks stop with no error | Stale CA trust store — see step 5 |
| Every POST is 403 | `APP_SECRET` does not match the app, or nginx is rewriting the body |
| `ERR_MODULE_NOT_FOUND` on boot | `npm run build:server` was not re-run after a pull |
| Handshake fails | `VERIFY_TOKEN` mismatch, or nginx is not proxying `/webhook` |
| Dashboard shows 503 | `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` unset |
| Dashboard is empty | Schema not applied, or no traffic since logging shipped |
| Templates missing from the dashboard | `WABA_ID` unset, so the nightly pull has nothing to query |
