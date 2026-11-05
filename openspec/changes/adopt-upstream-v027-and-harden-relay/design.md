# 设计：以官方 v0.2.7 为新基线，保留远程控制并完成安全与工程实践升级

## 1. 总体方案

采用“新基线 + 重放”而不是 merge：

```
upstream/main 71d344bf (v0.2.7)
        │
        ├── sync/upstream-v0.2.7   ← 新分支
        │      ├── 复制 fork 独有目录 relay/ web/ android/
        │      ├── 重放本地仍需要的提交（跳过发布/merge/生成物）
        │      ├── 恢复 relay 集成点
        │      └── 安全加固 + 工程实践
        │
        └── main (0.2.15)          ← 保留原分支，作为回滚点
```

不 merge 两条历史；`git cherry-pick` 只用于提取本地提交的 diff，冲突时以官方实现为准。

### 1.1 本地提交重放策略

| 本地提交 | 处理 |
|---|---|
| `4b80da45` 初始导入 | 不重放整树；把 `v0.2.3 → 4b80da45` 的 45 个路径 delta 中 fork 独有的部分移植到 v0.2.7 |
| `a296c770` scoped rename | 不整 commit cherry-pick；按文件重新应用 `@lininn/ds-bot` 命名 |
| `7b6e0aaa` CLI/scan 修复 | 重放，冲突按官方脚本调整 |
| `e88f24c3` client bundle 名称 | 保留构建脚本改动，`client.js` 由 build 生成 |
| `c1fa4a2e` 手机壳复用 PC 视图 | 保留 `web/`，按官方 client 导出重新适配 |
| `167948c2` Android 壳 | 整目录保留，按新版本号/主题适配 |
| `d540a544`、`dce6402f`、`2e6819ee`、`4e242d97` | 跳过发布/版本提交；只取其中的配置修正（DSH rc.5 官方已有） |
| `d71b7c80` 安装包 registry 规避 | 按需重放 release 配置 |
| `618eb952` 快速开始/架构图 | 文档手工重写 |
| `d9f9bf57` 新群会话/复制群 | 只保留 UI 增量；host 部分基于官方 `room.sessionId` 重写 |
| `60e53d3c`、`e30dea53` mac 安装器 | 保留 `install-app.mjs`、测试与 `first-run`/`host-process` 接线 |
| `4e242d97` DSH rc.5 | 官方已是 rc.5，跳过 |
| `3e8ac9cf` 发布文档 | 手工重写 |
| `0f8e6353`、`0a547dea` relay 修复 | 重放，按新 relay.js 结构改写 |
| `1c042ad0` 群聊在窗口/手机显示 | 不重放 host/feed/parts；采用官方群聊视图，只保留 `app/ui/src/chat.js` 与 web 适配中仍需要的部分 |
| `c6135ea8` 手机首帧/下拉刷新 | 保留 `web/index.html`、Android 主题/下拉刷新 |

### 1.2 集成点恢复

官方 v0.2.7 的 `channel.js` 仍定义 `handle(endpoint, body, signal)`，并注册 `/api` 的 Fetch 路由，但不再设置 `rt.handle`。fork 需要补：

- `rt.handle = handle`；
- `relay-status`、`relay-login`、`relay-logout`、`relay-reconnect` 四个端点及其 READS 区分；
- `feed.subscribeFeed` 钩子（官方 `feed.js` 没有该钩子，需要补回，不能整文件覆盖）；
- 手机端点白名单（`src/shared/relay-protocol.js`），策略为**默认拒绝**，逐项列出允许端点。

官方已删除 `room-continue`、`relayLimit`，**不恢复**；对应的本地 UI 与设置一并退役。

官方 `chat` 端点只接受 `botId`；群聊由官方 client 的 session/feed 机制承载。fork 删除 `room-chat` 端点，Web Shell 改用官方群聊视图，避免维护第二套群聊读取逻辑。

### 1.3 退役清单

- `relaySessionOf` / `roomBySession` → 官方 `sessionOfRoom` / `roomOwners`；
- `room-continue`、`relayLimit`、`relayLimitDefault`；
- 本地 `room-chat` 与 `d9f9bf57` 的 host 群聊补丁；
- 本地 `1c042ad0` 的 `parts.js` / `channel.js` / `feed.js` 群聊改造；
- 旧 `app/src/main.mjs` 启动流程（采用官方 start-window 架构后）。

### 1.4 数据兼容

- `state` 版本保持 1；官方 store 已能读取本地 `room.sessionId`、`ownParts`。
- 迁移前把 `state.json` 复制为 `state.json.bak-<timestamp>`。
- 官方会删除 `room.relays`/`relayLimit`；在迁移日志中记录被删除的设置，并在桌面设置页提示旧设置已退役。
- 未知顶层字段尽量保留；无法保留时写迁移说明。
- 手机 session 因凭证模型变化会失效，必须重新登录一次；桌面设备凭证也会失效，需要重新登录/配对一次。前端必须给出明确提示，不能静默失败。
- `sync/upstream-v0.2.7` 本身不是发布分支；发布前需要用户确认后把 `main` 指向新基线（见 §4 与 §6）。

## 2. 安全设计（保留现有账号登录）

### 2.1 信任边界

```
手机 ──HTTPS──▶ relay ──WS(ciphertext? no)──▶ 桌面 connector
```

relay 仍是可信中转（本轮不做 E2E）；目标是**最小化 relay 能拿到的长期凭证**，并让所有外部输入有边界。

### 2.2 会话与凭证

- 登录成功后，relay 生成 256-bit 随机 `sessionId`，写入 HttpOnly cookie；服务端维护
  `sessions` 表，键为 `sha256(sessionId)`，值为 `{ username, displayName, createdAt, lastSeen }`。
- 会话持久化到 `DSBOT_RELAY_DATA/sessions.json`（默认 `./data/sessions.json`）；relay 重启后
  手机无需重新登录。文件权限 600，写入使用临时文件 + rename。
- cookie 名：生产 `__Host-relay_session`（Secure、Path=/、无 Domain、SameSite=Lax）；
  本地 http 开发用 `relay_session`，由 `COOKIE_SECURE=0` 控制。
- TTL 7 天，空闲 24 小时过期；每次请求更新 `lastSeen`；退出登录删除会话。
- **cookie 不包含 access token**；access token 只在登录请求内使用，不落 cookie、不下发手机。
- 退出或吊销会话/设备时，必须同时关闭该会话的 SSE 流和已绑定的 connector socket，
  不能只让后续请求返回 401。
- 桌面连接器：`/api/desktop/login` 验证 blog token 后，relay 签发独立设备凭证
  （随机 256-bit），只返回一次；桌面存 `relay.json`（权限 600）。
- relay 持久化设备注册表 `DSBOT_RELAY_DATA/devices.json`：
  `{ username, deviceId, machineId, tokenHash, name, pairedAt, revokedAt }`。
- 验证：`sha256(token)` 常量时间比较；`machineId` 由连接器在**每次启动时重新计算**并随
  bind 发送，不从 `relay.json` 读取；不匹配则拒绝。复制 `relay.json` 到另一台机器会因
  新机器 `machineId` 不同而被拒绝；支持按设备吊销。
- 同一 `deviceId` 已连接时，仅当 token/machineId 一致才替换旧连接；否则 4002，不再让
  任意同账号 token 顶掉真机。
- 协议版本升级为 `RELAY_PROTOCOL = 2`（bind 凭证形态变化）；v1 connector 以 4003 关闭并
  返回明确升级提示。`cancel` 帧属于 v2，旧客户端不会收到/发送它。
- systemd 单元使用 `StateDirectory=ds-relay` 或 `ReadWritePaths=/opt/ds-relay/data`，
  否则 `ProtectSystem=strict` 下无法写会话与设备注册表。
- 保留 blog `/api/relay/auth` 与 `/api/desktop/login` 的现有调用方式；不新增二维码/密钥配对。

### 2.3 限流与防护

- `TRUST_PROXY=1` 时只信任配置的代理 CIDR（默认回环）；从右向左跳过受信代理，取第一个
  非受信地址作为客户端 IP。nginx 默认追加 `$proxy_add_x_forwarded_for`，最左值可伪造，
  不能使用“第一跳”。`TRUST_PROXY=0` 时直接使用 socket IP。
- 登录按 IP + 账号双维度：15 分钟 10 次，失败 5 次锁定 15 分钟；成功清零。为避免用他人
  账号制造锁定，账号级锁定阈值提高到 50 次/15 分钟，且成功登录会清除该账号计数。
- 失败记录 Map 每 60 秒清理过期项；上限 10k 条，超限淘汰最旧，但不得淘汰仍在锁定窗口内
  的记录（优先淘汰已过期/最久未更新项）。
- `/connector` 每账号最多 10 条、全局最多 1000 条；超出 1013 关闭。另外限制未 bind 的
  socket：全局最多 2000 条、单 IP 最多 100 条、30 秒内必须完成 bind，否则关闭。
- WebSocket：`maxPayload = 1 MiB`；每连接 100 帧/秒令牌桶，超出 1008 关闭。
- REST body 上限 1 MiB；仅接受 `application/json`；保留 `sameOrigin` 并补 `Origin` 缺失拒绝，
  但 `/api/desktop/login` 例外（桌面 connector 不带 Origin）。
- 安全响应头：CSP、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、
  `X-Frame-Options: DENY`。

### 2.4 可靠性与资源边界

- SSE：每设备（按 connector/deviceId，而不是按手机 session）最多 4 个客户端；`res.write()`
  返回 false 时暂停写入，事件进入每客户端有界队列；累计缓冲超过 4 MiB 或 30 秒未 drain
  则断开；客户端按 revision 重新拉取 state。禁止无界数组累积。
- 请求取消：新增 `MSG.cancel`（request id）。手机断开或主动取消时，relay 发 cancel；
  connector 用 `AbortController` 把 signal 传给 `rt.handle`。该帧属于协议 v2；v1 客户端
  不会收到 cancel，服务端也不向未知协议发送。
- 重连风暴：connector 用 generation 计数；只有当前 socket 的 close 才能安排重连；
  已有活跃 socket 时不清空/不重建；`scheduleRetry` 先去重。
- 请求超时保持 120 秒，但可被 cancel 提前结束。

### 2.5 静态资源与 Android

- `/web-dist/<ver>/assets/*` 为内容哈希文件，`Cache-Control: public, max-age=31536000, immutable`；
  `index.html` 与 manifest `no-store`。
- 对 HTML/JS/CSS/JSON 做 gzip；SSE 路径禁用压缩和缓冲。
- 保留最近 2 个版本；新增 `scripts/prune-web-dist.mjs`，为其写单元测试，并在发布/部署
  流程（`relay/scripts/sync-web.mjs` 之后）实际调用，不能只创建脚本。
- Android release `usesCleartextTraffic=false`；`src/debug/AndroidManifest.xml` 允许明文，
  仅调试构建使用；WebView 关闭 file access 与 mixed content。

## 3. 群聊与记忆

- 直接使用官方 `groups.js`、`turns.js`、`parts.js`、`roster.js`、`delivery.js`、`goals.js`、
  `memory.js`、`learning.js` 与对应测试；不保留 fork 的旧群聊引擎补丁。
- 官方群聊视图已经通过 `roomsById`/`sessionId` 读取；Web Shell 复用同一组件，不再使用
  fork 的 `room-chat`。
- 新增 `new-room-conversation` / `duplicate-room` 作为独立增量：
  - `new-room-conversation`：保留群名/成员/设置/记忆，归档旧会话，生成新 `room.sessionId`；
  - `duplicate-room`：复制成员与设置，不复制会话与记忆。
  - 以官方 `room.sessionId`、`roomOwners` 为基础实现，不修改官方 turn 流程。
- relay 与 connector 统一改为**默认拒绝**的手机端点白名单，逐项列出允许端点：
  `state`、`models`、`efforts`、`thinking`、`exchange`、`exchange-text`、`file-text`、
  `earlier`、`chat`、`send`、`resume`、`run-stats`、`usage`、`room-progress`、
  `create-bot`、`update-bot`、`delete-bot`、`set-main`、`set-prefs`、`duplicate-bot`、
  `create-room`、`update-room`、`delete-room`、`add-agent`、`remove-agent`、
  `agent-session`、`agent-adopt`、`agent-archive`、`agent-rename`、`set-flags`、
  `approval-answer`、`dismiss-question`、`dismiss-view`、`stop-member-work`、
  `stop-room-work`、`goal-draft`、`goal-control`、`avatar-library`、`avatar-import`、
  `avatar-delete`、`folders`、`folder-list`、`team-workspace`、`private-release`、
  `memory-history`、`memory-restore`、`learning-answer`、`new-room-conversation`、
  `duplicate-room`。
- 继续拒绝：`providers`、`provider-*`、`secret-*`、`capability-*`、`connector-*`、`relay-*`、
  `diagnostics*`、`folder-pick`、`update-install`、`dsh-update-install`。
- 新增端点必须先加入白名单并补允许/拒绝测试，否则默认不可达。

## 4. 工程实践

- 先补齐依赖与 lockfile：`web/` 当前没有 `package-lock.json`，必须先生成并提交，否则
  `npm ci` 无法运行。`ds-bot/` 按官方加入 `deep-view@0.1.0` 并更新 lockfile。
- CI 新增：
  - `relay` job：`npm ci && npm test`；
  - `web` job：`npm ci && npm run build`（依赖提交后的 lockfile）；
  - `android` job：仅在 `android/**` 或 release 变更时构建 APK；仓库没有 `gradlew`，
    使用 CI 已配置的系统 `gradle`；
  - `security` job：relay 安全测试 + `node scripts/scan.mjs <path>`；
  - 把上述 job 加入 `.github/workflows/test.yml` 的最终 `result` gate，否则失败不会阻止合并。
- CHANGELOG 使用 Keep a Changelog；每条挂本变更任务 ID。
- `docs/plans/2026-11-05-upstream-sync.md` 记录本次架构决策、退役项和回滚步骤。
- 版本策略：下一版本使用 `0.3.0`（相对官方 0.2.7 明确领先，且包含破坏性端点退役）；
  npm 包名保持 `@lininn/ds-bot`。四包版本、`web/manifest.json` 和
  `relay/web-dist/<version>` 必须一致；发布前运行 `node relay/scripts/sync-web.mjs 0.3.0`。
- 发布晋级：`sync/upstream-v0.2.7` 验证通过后，由用户确认把 `main` 指向新基线；不执行
  该步骤则 `release.yml` 不会从新基线发布。
- 测试命名沿用行为句子；新增安全测试覆盖：会话不含 token、会话重启恢复、吊销关闭长连接、
  设备顶替、复制 `relay.json`、限流、WS 超限、SSE 慢消费者、cancel、重连去重、协议 v1 拒绝。
- 运行 `ds-bot` 测试前先执行 `npm run harness`（CI 已这样做）；仓库没有 `dev/` 目录。

## 5. 实施顺序（按依赖）

1. 建分支、复制 fork 独有目录、恢复集成点；
2. 重放本地功能提交，先让 `ds-bot` 测试/构建通过；
3. 适配 app/web/android，跑通桌面与手机；
4. relay 安全改造（在基线适配完成后开始，避免与 app/web 适配交叉）；
5. ds-bot 侧安全（cancel、重连、feed 边界）；
6. 群聊/记忆官方行为验证与增量功能；
7. 工程实践与 CI；
8. 全量验证、迁移演练、发布说明；
9. 用户确认后把 `main` 晋级到新基线并发布。

## 6. 回滚

- 新分支独立，`main` 不动；任何阶段可回到 `main` 的 0.2.15。
- relay 安全改造升级协议到 v2：v1 connector 以 4003 拒绝并提示升级；不尝试兼容旧 cookie，
  旧 cookie 直接要求重新登录并清理。
- 会话与设备注册表位于 `DSBOT_RELAY_DATA`；损坏时拒绝启动并保留原文件，不静默重建。
- 数据迁移前备份；若迁移失败，恢复 `state.json.bak-<timestamp>`。
- Web Shell 版本回退：relay 保留上一个版本目录，手机可回退到旧版本页面。
- 发布晋级是唯一会改写 `main` 的步骤，必须单独获得用户确认；回退时把 `main` 指回
  原 `c6135ea`（0.2.15）并重新部署旧 relay/web-dist。
