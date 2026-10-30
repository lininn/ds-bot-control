# DS Bot relay

Lets a phone sign in on a website, pick one of its own computers, and drive that computer's
DS Bot team. The desktop app keeps an **outbound** WebSocket to this process, so no port is
opened on the desktop.

```
phone ──HTTPS──▶ relay ──WS (outbound)──▶ desktop ds-bot (relay.js)
  │                │
  └── /web-dist/<version>/  (the built @lininn/ds-web shell)
```

## Pieces

- `src/index.js` — HTTP routes, static shell per version, WebSocket upgrade at `/connector`.
- `src/auth.js` — blog login (`/api/relay/auth`) and the signed `relay_session` cookie.
- `src/connector.js` — desktop registry, request/response correlation, feed fan-out, heartbeat.
- `src/static.js` — versioned `WEB_STATIC_DIR/<version>/` serving and the mismatch page.
- `src/protocol.js` — copy of `ds-bot/src/shared/relay-protocol.js`.

## Phone routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/login` | login form |
| POST | `/api/login` | blog login → session cookie |
| POST | `/api/desktop/login` | a desktop app signs in → its account's access token (no device needed) |
| POST | `/api/logout` | clear cookies |
| GET | `/devices` | device picker |
| GET | `/api/devices` | devices (JSON) |
| POST | `/api/devices/select` | remember the chosen device |
| GET | `/` | the shell for the chosen device's version |
| GET | `/web-dist/<version>/*` | static shell files |
| POST | `/web-dist/<version>/api/bot` | one `api/bot` call to the desktop |
| GET | `/web-dist/<version>/api/bot/feed` | the desktop's live feed (SSE) |

The shell is built with `base: './'`, so `fetch('api/bot')` resolves under the versioned
directory. The relay also accepts bare `/api/bot[/feed]`.

The desktop app turns remote control on in **Settings → Remote control** in DS Bot: it calls
`/api/desktop/login`, stores the returned token under its team home, and binds `/connector`.
Nothing needs to be edited in the profile by hand; `relay: false` or `enabled: false` in the
plugin config turns the feature off.

## Configure

Copy `.env.example` to `.env` (or set the variables in the process). `BLOG_API_URL` and
`SESSION_SECRET` are required for anything but local development.

Accounts: the blog defaults to **admin-only** for relay tokens. To let every user sign in,
set `RELAY_ADMIN_ONLY=0` on the **blog** process. The relay cannot override that.

## Deploy a web version

Publish `@lininn/ds-web@<version>` first, then unpack it where the relay can serve it:

```bash
node scripts/sync-web.mjs 0.2.3 /srv/ds-relay/web-dist
```

This runs `npm pack` (no runtime `npm install`), checks `manifest.json`'s version, and writes
`web-dist/0.2.3/index.html` and `web-dist/0.2.3/assets/` (the contents of the package's
`dist`, flattened one level, plus `manifest.json`). A desktop reporting a version with no
directory gets the mismatch page.

## Run

```bash
npm install
npm start        # node src/index.js
npm test
```

Behind nginx, the feed needs buffering off:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $http_host;   # must pass the browser's Host through
  proxy_buffering off;                # required for SSE
  proxy_read_timeout 3600s;
}
```

`Host` matters: `/api/login`, `/api/desktop/login` and `/api/devices/select` compare the
request's `Origin` against its `Host`. Under a reverse proxy the default `proxy_set_header
Host $proxy_host` sends `127.0.0.1:8787` while the browser sends the public origin, so the
check fails with 403 and sign-in looks broken. Use `$http_host` (or `$host`). The desktop
connector calls `/api/desktop/login` with its own Node client, which sends no `Origin`, so it
is not affected.

## Deploy on kd1 (the public relay)

The production relay runs on `kd1` behind 1Panel's OpenResty, on `ds.d-1.top`.

- Code: `/opt/ds-relay`, synced from this directory (`src/`, `scripts/`, `package.json`,
  `README.md`). Then `npm install --omit=dev` with Node 24 (the nvm copy, not the system
  Node 12).
- `.env`:

  ```env
  PORT=8788
  BLOG_API_URL=http://127.0.0.1:3001        # the blog runs on the same host
  SESSION_SECRET=<openssl rand -hex 32>
  COOKIE_SECURE=1                            # behind TLS; 0 only while testing over http
  WEB_STATIC_DIR=/opt/ds-relay/web-dist      # absolute; relative paths depend on WorkingDirectory
  ```

- Web shell: build `web/` (`npm run build`) and copy the **contents** of its `dist` to
  `/opt/ds-relay/web-dist/<ds-bot version>/` — that is `index.html` and `assets/`. The
  directory name must equal the desktop's DS Bot version (currently `0.2.4`); the relay
  checks for `index.html` and does not read `manifest.json` at runtime.
- systemd: `/etc/systemd/system/ds-relay.service`, `Type=simple`,
  `WorkingDirectory=/opt/ds-relay`, `EnvironmentFile=/opt/ds-relay/.env`,
  `ExecStart=/root/.nvm/versions/node/v24.14.1/bin/node src/index.js`, `Restart=always`,
  `RestartSec=3`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`,
  `IPAddressDeny=any` + `IPAddressAllow=localhost` (the process only needs loopback: the
  blog on `127.0.0.1:3001` and OpenResty on `127.0.0.1:8788`). Do not add
  `ProtectHome=read-only` — it would hide `/root/.nvm`.
- OpenResty (1Panel host-network container, so `127.0.0.1` reaches the process). The live
  site is created and owned by 1Panel (`/opt/1panel/www/conf.d/ds.d-1.top.conf`, certificate
  under `/opt/1panel/www/sites/ds.d-1.top/ssl/`, issued with the DNS-01 challenge); 1Panel
  writes the 443 block and the certificate paths, so let it manage those. The SSE/WS tuning
  goes in the site's proxy file, which 1Panel generates from the site's reverse-proxy
  settings: `/opt/1panel/www/sites/ds.d-1.top/proxy/root.conf` needs `proxy_set_header Host
  $http_host`, `proxy_buffering off`, `proxy_cache off`, `gzip off`, `proxy_read_timeout
  3600s` and the `Upgrade`/`Connection` pair. Re-applying the site's proxy settings in 1Panel
  regenerates that file, so keep the extra directives somewhere it will not lose them.
  [`deploy/ds.d-1.top.conf`](deploy/ds.d-1.top.conf) is the same shape for a plain nginx
  where no panel owns the file.
- Rate limiting: `loginAllowed` keys its 10-per-minute limit on the socket address, and the
  process does not read `X-Forwarded-For`. Behind the proxy every request looks like
  `127.0.0.1`, so the limit becomes global. Add a per-client limit in OpenResty
  (`limit_req` on `$binary_remote_addr`) if that matters.
- Verify locally on the host: `curl 127.0.0.1:8788/health` → `{"status":true}`,
  `/login` → 200, `/web-dist/<version>/` → 200, and a wrong `/api/login` → 401.

## Security

- The phone only reaches endpoints in `api/bot`; `provider-*`, `secret-*`, `diagnostics*`,
  `connector-*`, `providers`, `folder-pick`, `update-install` and `dsh-update-install` are
  refused, both here and in the desktop connector.
- A session only ever resolves devices belonging to its own username.
- Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` behind TLS.
- The registry is in memory: run one relay instance (or add shared state) for multiple
  replicas.
