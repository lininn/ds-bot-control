# 提案：手机网页 + PC 应用通过 ds.d-1.top 同账号远程控制

## Why

DS-Bot 的团队跑在用户自己的电脑上，但人常常在手机上。现有实现已经有出站 connector、relay 服务和手机网页壳，但还差三件事才能真实可用：

1. 两端都要手填 relay 地址，体验断裂。
2. 手机网页壳没有「切换设备」入口，多台电脑时只能靠服务端选择页。
3. relay 只在本机验证过，没有部署到 kd1，也没有把网页壳下发。

目标形态（参考 zcode）：

```
手机浏览器 ──HTTPS──▶ ds.d-1.top (relay) ──出站WS──▶ PC 端 ds-bot connector
     │                     │
     └── /web-dist/<ver>/  └── /api/desktop/login 给 PC 端换 token
```

单账号、可挂多台电脑；登录后选设备。blog 在 `lininn.cn`，relay 在 `ds.d-1.top`，两者不同域名、同部署在 kd1。

## What Changes

### A. 默认地址注入（ds-bot）

- `src/host/relay.js`：导出 `DEFAULT_RELAY_URL = 'https://ds.d-1.top'`；`configuredUrl()` 优先级为 `saved.url` → `config.url` → `env.DS_BOT_RELAY_URL` → `defaultUrl`。空串一律视为未设置（`DS_BOT_RELAY_URL=''` 时继续落到 `defaultUrl`，否则会卡在空串）。
- `createRelayController` 新增参数 `defaultUrl = DEFAULT_RELAY_URL`，便于测试覆盖为空。
- 设置页 `src/client/relay-settings.js` 无需改动：地址字段已用 `status.url` 预填，默认值自然生效，用户仍可改。已知行为：默认值让地址栏恒有值，手动清空后 2.5s 轮询会回填，等于无法留空（记录在文档里）。
- `test/relay.test.js`：
  - 新增「无任何配置时默认 `https://ds.d-1.top`」断言；
  - 原「没有地址时拒绝登录」用例（约 239 行）改为传 `defaultUrl: ''`——否则它会真的调用 `fetchImpl`，报错文案从 “Enter the relay address first” 变成 “Could not reach the relay”；
  - 新增 `env.DS_BOT_RELAY_URL=''` 时仍落到默认值的断言。

### B. 多设备选择（web 壳）

- 服务端已有 `/devices` 选择页、`DEVICE_COOKIE` 记忆、单设备自动进入——保留。
- `web/src/app.js`：根视图 header 增加「切换设备」按钮，`location.assign('/devices')`。
- `web/src/mobile.css`：对应按钮样式（沿用 `m-bar` 既有变量）。
- 说明：壳部署在 `/web-dist/<ver>/`，`/devices` 用绝对路径回到 relay 根路由。

### C. relay 部署到 kd1

- 目录 `/opt/ds-relay`，从本仓库 rsync `relay/`（含 `src/`、`scripts/`、`package.json`），再 `npm install --omit=dev`（relay 无 lockfile，固定 ws 8.18.3）。
- `.env`：
  - `PORT=8788`
  - `BLOG_API_URL=http://127.0.0.1:3001`（与 `/opt/zcode-relay` 一致，blog 在本机）
  - `SESSION_SECRET=<openssl rand -hex 32>`
  - `COOKIE_SECURE=1`（TLS 之后；本地 http 自测先置 0，否则登录“成功但无会话”）
  - `WEB_STATIC_DIR=/opt/ds-relay/web-dist`（绝对路径；`./web-dist` 依赖 WorkingDirectory，易错）
- 监听 `0.0.0.0:8788`（用户确认）。安全上只让 OpenResty/防火墙放 443：ufw/nft 只开 443，或 unit 加 `IPAddressDeny=any` + `IPAddressAllow=localhost`。
- systemd：`/etc/systemd/system/ds-relay.service`，`Type=simple`、`WorkingDirectory=/opt/ds-relay`、`EnvironmentFile=/opt/ds-relay/.env`、`ExecStart=/root/.nvm/versions/node/v24.14.1/bin/node src/index.js`、`Restart=always`、`RestartSec=3`、`NoNewPrivileges=yes`、`PrivateTmp=yes`、`ProtectSystem=strict`。**不要**加 `ProtectHome=read-only`（会挡住 `/root/.nvm`）；若改用非 root 用户，须先把 node 装到系统路径。
- 网页壳下发：本地 `cd web && npm run build`，把 `web/dist/` 的**内容铺平**到 `/opt/ds-relay/web-dist/0.2.4/`（即 `index.html`、`assets/`、`manifest.json`）。运行时只认 `<ver>/index.html`，**不校验 manifest**；目录名必须等于 ds-bot 版本（当前 0.2.4）。
- OpenResty（给用户配置域名时用，本提案提供样例）：
  - `proxy_set_header Host $http_host;` —— **必须**，否则 `sameOrigin` 校验把 `/api/login`、`/api/desktop/login` 拒成 403；
  - `proxy_http_version 1.1;` + `Upgrade`/`Connection`（用 `map $http_upgrade`）；
  - SSE：`proxy_buffering off;`、`gzip off;`、`proxy_cache off;`；
  - `proxy_read_timeout 3600s;`。
- 限流提醒：`clientIp` 取 socket 地址，反代后全是 `127.0.0.1`，relay 自身 10 次/分限流会变成全局；建议在 OpenResty 用 `limit_req` 按 `$binary_remote_addr`（relay 当前不读 `X-Forwarded-*`）。
- 不动 blog 的 `RELAY_ADMIN_ONLY`（单账号，保持默认 admin-only）。

### D. PC 端验证（app/）

- 代码层面已具备，但依据是 **DSH Web 窗口 + ds-bot client overlay**，不是 `app/ui/`：`app/README.md:148-149` 写明 `ui/` 已停用、不参与打包；`app/electron-builder.yml` 只打包 `src/assets`。实机窗口加载 DSH Web，远程控制页由 `ds-bot/src/client/index.js` 注册的 `Overlays`（`overlays.js` → `settings.js`）渲染。`app/src/profile.mjs` 的 `BUNDLES` 含 `ds-bot`，host 侧 relay connector 因此加载。
- 需实机确认两件事：
  1. Electron 44 的 Node 模式是否有全局 `WebSocket`（connector 依赖）。
  2. `api/bot` 的通用转发能到达 `relay-status/login/logout`。
- 若不支持 `WebSocket`：为 connector 增加 `ws` 回退（仅在全局缺失时按需加载）。

### E. 文档与发布

- `ds-bot/README.md`：补充默认地址、kd1 部署说明、单账号多设备行为。
- `relay/README.md`：kd1 部署参数（8788、本机 blog、systemd）。
- 版本保持 0.2.4；发布走 GitHub release（不手动 `npm publish`）。

## 验收标准

- [ ] `curl http://127.0.0.1:8788/login` 返回 200。
- [ ] `curl http://127.0.0.1:8788/web-dist/0.2.4/` 返回网页壳 HTML。
- [ ] `systemctl status ds-relay` 为 active，重启主机后自动拉起。
- [ ] 手机登录 `https://ds.d-1.top` → 看到设备列表 → 进入壳 → 给 Bot 发消息有回复。
- [ ] 同账号两台电脑同时在线 → 手机出现设备选择，可切换。
- [ ] PC 端断开后手机显示离线；PC 端「退出登录」后手机失效。
- [ ] ds-bot 全量测试通过（含新增默认地址用例）、`node scripts/lint.mjs` exit 0。
- [ ] relay 测试 14/14 通过。

## 风险

- **Electron WebSocket 全局**：未实测；最坏情况需要 `ws` 回退，属于 D 组任务。
- **默认地址的副作用**：只配了 `config.token`、没有 url 的旧部署会静默连到 `ds.d-1.top`；文档需点明，可用 `relay.url` 覆盖。
- **Host 头**：反代未透传 `Host` 时，登录会被 `sameOrigin` 拒成 403（桌面 connector 不带 Origin，不受影响）。
- **限流**：反代后 `clientIp` 全为 `127.0.0.1`，relay 的 10 次/分限流变成全局；需在 OpenResty 侧按真实 IP 限流。
- **blog 鉴权接口**：`/api/relay/auth` 需在 `lininn.cn` 可用且该账号为 admin；部署后先用错误密码确认返回 401 而非 500/403。
- **域名与 TLS**：由用户最后配置；在此之前只能用 `http://127.0.0.1:8788` 自测，`COOKIE_SECURE=1` 时 http 下登录 cookie 不生效，自测可临时置 0。
- **OpenResty**：需 `Host` 透传、`proxy_buffering off`（SSE）、`Upgrade`/`Connection`（WS）。
- **版本一致性**：`web-dist/<ver>` 的目录名必须等于 ds-bot 版本；运行时只认 `index.html`，不校验 manifest。

## Out of scope

- 多账号支持（明确不做）。
- 把网页壳塞进 Electron 做「桌面版」。
- npm 实际发布动作（用户/维护者决定）。

## 评审记录（两路独立 review）

- 代码/架构：D 组原依据 `app/ui` 不成立（已改为 DSH Web + ds-bot overlay）；A 组测试必须传 `defaultUrl:''`（已补）；默认值导致地址栏无法留空（已记录）；两份 protocol 的白名单一致，`relay-*` 会被拦，符合预期。
- 部署/安全：Host 透传、版本目录、非 root+nvm 为阻断/硬约束（已写入 C 组）；限流按回环 IP、0.0.0.0 暴露、Cookie Secure、WS/SSE 反代参数（已写入 C 组与风险）。
- 结论：提案在代码层成立，部署层可行；无设计性返工。

## 任务拆分

1. **A1** ds-bot：`DEFAULT_RELAY_URL` + `defaultUrl` 参数 + 优先级 + 空串视为未设置。
2. **A2** ds-bot：更新/新增 `relay.test.js` 用例（默认值、`defaultUrl:''`、env 空串）。
3. **B1** web：header「切换设备」按钮 + 样式。
4. **B2** web：`npm run build`，确认产物结构。
5. **C1** kd1：`/opt/ds-relay` 代码 + `npm install --omit=dev`。
6. **C2** kd1：`.env`（8788 / 本机 blog / 绝对 WEB_STATIC_DIR / 随机 secret / 自测期 COOKIE_SECURE=0）。
7. **C3** kd1：systemd 单元（含加固项，不加 ProtectHome）+ 启动 + 开机自启。
8. **C4** kd1：把 `dist` 内容铺平到 `web-dist/0.2.4/`。
9. **C5** kd1：本机 `curl` 验收 `/health`、`/login`、`/web-dist/0.2.4/`，错密码应 401。
10. **C6** kd1：防火墙只放 443（或 unit 加 IPAddressDeny/Allow）；给出 OpenResty `ds.d-1.top` 样例（Host/WS/SSE/限流）。
11. **D1** 实机验证 PC 端「远程控制」页与 connector；必要时加 `ws` 回退。
12. **E1** 文档更新（ds-bot / relay README，含 OpenResty 样例与默认地址说明）。
13. **E2** 汇总验证证据（测试、curl、systemctl）。
