# 任务：以官方 v0.2.7 为新基线，保留远程控制并完成安全与工程实践升级

> 顺序固定为：准备 → 换基线 → relay 安全 → ds-bot 安全 → 群聊/记忆 → 工程实践 → 验证与晋级。
> 每个任务都是一个可独立验证的垂直切片；未通过这些任务的验证命令，不得勾选完成。
> 上游引用一律使用 SHA `71d344bf`（v0.2.7），不使用本地 tag。

## 0. 准备

- [ ] **0.1 安装依赖、补齐 lockfile、记录基线**
  - 文件：`web/package-lock.json`（新建）、各包 lockfile（如更新）
  - 操作：
    - `web/` 当前没有 lockfile；执行 `cd web && npm install --package-lock-only` 并提交。
    - `ds-bot/`、`app/`、`relay/` 按各自 lockfile 安装。
    - 运行 `cd ds-bot && npm run harness`，再记录当前测试基线。
  - 验证：
    - `ls web/package-lock.json`
    - `cd ds-bot && npm run harness && npm test`
    - `cd app && npm test`
    - `cd relay && npm test`
  - 证据：四条命令的结果与失败项清单（作为换基线前的对照）。

## 1. 换基线（P0，阻塞其余全部任务）

- [ ] **1.1 建立新基线分支并记录回滚点**
  - 文件：无（仅 Git 操作）
  - 操作：从 `upstream/main` 的 `71d344bf` 创建 `sync/upstream-v0.2.7`；`main` 保持不动。
  - 验证：
    - `git merge-base main sync/upstream-v0.2.7` 输出为空
    - `git rev-parse sync/upstream-v0.2.7^{tree}` 与 `git rev-parse 71d344bf^{tree}` 一致
  - 证据：分支名、起点 SHA、merge-base 输出（空）。

- [ ] **1.2 移植 fork 独有层到新基线（只取 fork 文件）**
  - 复制：
    - `relay/`
    - `web/`
    - `android/`
    - `ds-bot/src/host/relay.js`
    - `ds-bot/src/shared/relay-protocol.js`
    - `app/src/install-app.mjs`
  - 手工重放（不要整文件覆盖官方版本）：
    - `app/src/first-run.mjs`、`app/src/host-process.mjs`、`app/src/host.mjs` 中仅 fork 的 Host 心跳接线
    - `ds-bot/package.json` 增加官方 `deep-view@0.1.0` 依赖并更新 lockfile
  - 不复制：`ds-bot/client.js`、官方已重写的 `app/src/main.mjs` / `shell.mjs`
  - 验证：
    - `git diff --stat 71d344bf -- relay web android ds-bot/src/host/relay.js ds-bot/src/shared/relay-protocol.js app/src/install-app.mjs`
    - `node -e "console.log(require('./ds-bot/package.json').name)"` 输出 `@lininn/ds-bot`
    - `git show HEAD:ds-bot/package.json | grep deep-view`
  - 证据：diff 摘要与包名/依赖输出。

- [ ] **1.3 按策略重放本地提交**
  - 文件范围：按 design.md §1.1 表格逐个提交处理。
  - 必须跳过：`d540a544`、`dce6402f`、`2e6819ee`、`4e242d97`（发布/版本/DSH rc.5）、merge `a6bbb593`、生成的 `ds-bot/client.js`。
  - 只取配置修正：`7b6e0aaa`、`e88f24c3`、`d71b7c80`、`60e53d3c`、`e30dea53`、`618eb952`、`3e8ac9cf`。
  - 按官方实现重写：`0f8e6353`、`0a547dea`、`d9f9bf57`（host 部分）、`c1fa4a2e`、`167948c2`、`c6135ea8`。
  - 不重放 host/feed/parts 群聊补丁：`1c042ad0` 仅保留 `app/ui/src/chat.js` 与 web 适配中仍需要的行为。
  - 验证（cherry-pick 后 SHA 会变，不能用 SHA 缺失证明）：
    - `git log --oneline 71d344bf..sync/upstream-v0.2.7`
    - 对每个跳过提交，用 `git patch-id --stable` 或内容 diff 确认其 patch 未进入新分支
    - `git log --oneline -1 -- ds-bot/client.js` 不显示手工提交
  - 证据：重放清单（提交 → 处理方式 → patch-id/内容比对结果）。

- [ ] **1.4 恢复 relay 集成点**
  - 文件：
    - `ds-bot/src/host/channel.js`（`rt.handle = handle`、`relay-status`、`relay-login`、`relay-logout`、`relay-reconnect`、READS 区分）
    - `ds-bot/src/host/feed.js`（补回 `subscribeFeed`；官方该文件没有此钩子）
    - `ds-bot/src/shared/relay-protocol.js`（默认拒绝的手机端点白名单、`MSG.cancel`、`RELAY_PROTOCOL = 2`）
  - 不恢复：`room-continue`、`relayLimit`、`relayLimitDefault`、`room-chat`。
  - 验证：
    - `rg "rt\.handle|relay-status|relay-login|relay-logout|relay-reconnect|subscribeFeed" ds-bot/src` 均有命中
    - `rg "room-continue|relayLimit|room-chat" ds-bot/src relay web app` 无生产代码命中（测试或迁移文档除外）
  - 证据：搜索输出与差异文件列表。

- [ ] **1.5 重新生成 client bundle 并让 ds-bot 通过**
  - 文件：`ds-bot/client.js`（仅由构建生成）
  - 操作：`cd ds-bot && npm run harness && node scripts/build-client.mjs`
  - 验证：
    - `cd ds-bot && npm test`
    - `cd ds-bot && npm run lint`
    - `cd ds-bot && node scripts/build-client.mjs --check`
  - 证据：三条命令的通过输出。

- [ ] **1.6 适配桌面 app 启动架构**
  - 文件：
    - `app/src/main.mjs`、`app/src/shell.mjs`、`app/src/window-frame.mjs`（对齐官方 start-window/whale 架构）
    - `app/src/install-app.mjs`、`app/src/first-run.mjs`、`app/src/host-process.mjs`（保留 macOS 安装器与心跳）
    - `app/package.json`（依赖随官方调整；版本在 5.3 统一）
  - 验证：
    - `cd app && npm test`
    - `cd app && npm run dist`（至少完成打包，不要求签名）
  - 证据：测试输出与产物路径。

- [ ] **1.7 适配 Web Shell 与 Android**
  - 文件：
    - `web/`（官方 client 导出、`deep-view`、版本握手）
    - `web/index.html`（首帧与下拉刷新保留）
    - `android/`（主题、下拉刷新、WebView 配置）
  - 验证：
    - `cd web && npm install && npm run build`（lockfile 由 0.1 生成）
    - `cd android && gradle --no-daemon assembleDebug`（仓库没有 `gradlew`，使用系统 gradle）
  - 证据：构建输出与 APK 路径。

- [ ] **1.8 实现 state 迁移备份与退役提示**
  - 文件：
    - `ds-bot/src/host/store.js`（或官方等价加载入口）
    - `ds-bot/src/host/migrate.js`（如不存在则新建）
    - `ds-bot/src/client/relay-settings.js`（提示旧 relay 设置已退役、需要重新登录/配对）
    - 对应测试 `ds-bot/test/state-migration.test.js`
  - 行为：首次以新基线启动时复制 `state.json` 为 `state.json.bak-<timestamp>`；保持 state 版本 1；保留无法识别的顶层字段；把被删除的 `relayLimit`/`relays` 记录到迁移日志；桌面与手机显示明确的重新登录/重新配对提示。
  - 验证：
    - `cd ds-bot && npm test -- --test-name-pattern="migrat|state"`
  - 证据：测试输出、备份文件名示例、提示文案位置。

## 2. relay 安全（保留现有 blog 账号登录）

- [ ] **2.1 服务端会话表、持久化与安全 cookie**
  - 文件：
    - `relay/src/auth.js`
    - `relay/src/index.js`
    - `relay/src/config.js`
    - `relay/src/sessions.js`（新建：内存表 + `sessions.json` 持久化）
  - 行为：cookie 只存 256-bit 随机 session id；服务端键为 `sha256(sessionId)`；TTL 7 天、空闲 24 小时；退出/吊销删除会话并关闭关联 SSE 与 connector；重启后未过期会话仍有效；生产使用 `__Host-relay_session`（Secure、HttpOnly、SameSite=Lax、Path=/），`COOKIE_SECURE=0` 时用 `relay_session`；cookie 不含 access token。
  - 测试：`relay/test/session.test.js`（cookie 不含 token、过期 401、退出 401、重启恢复、吊销关闭流）。
  - 验证：`cd relay && npm test -- --test-name-pattern="session|logout|expire|cookie|restart|revoke"`。
  - 证据：测试输出与 `Set-Cookie` 断言。

- [ ] **2.2 桌面设备凭证、协议 v2 与注册表**
  - 文件：
    - `relay/src/auth.js`（`/api/desktop/login` 签发设备凭证）
    - `relay/src/devices.js`（新建：注册表读写）
    - `relay/src/config.js`（`DSBOT_RELAY_DATA`，默认 `./data`）
    - `ds-bot/src/host/relay.js`（保存 `relay.json`，权限 600；启动时重新计算 `machineId`）
    - `ds-bot/src/shared/relay-protocol.js`、`relay/src/protocol.js`（`RELAY_PROTOCOL = 2`）
    - `relay/README.md`（systemd `StateDirectory`/`ReadWritePaths`）
  - 行为：只在登录响应返回一次随机 token；注册表存 `tokenHash`、`deviceId`、`machineId`、`name`、`pairedAt`、`revokedAt`；常量时间比较；`machineId` 由连接器运行时计算并随 bind 发送，不读取 `relay.json` 中的旧值；按设备吊销并关闭连接/SSE；同 `deviceId` 不同 token/machineId 返回 4002；v1 connector 以 4003 拒绝并提示升级。
  - 测试：`relay/test/devices.test.js`（签发、拒绝、吊销、顶替、复制 relay.json、v1 拒绝）。
  - 验证：`cd relay && npm test -- --test-name-pattern="device|revoke|duplicate|protocol|machine"`。
  - 证据：测试输出与注册表 JSON 示例（脱敏）。

- [ ] **2.3 限流、真实 IP、Origin 与连接上限**
  - 文件：
    - `relay/src/util.js`（受信代理 CIDR、右向左解析 XFF）
    - `relay/src/index.js`（登录限流、`/connector` 上限、未 bind 上限、WS 帧限制、`/api/desktop/login` Origin 例外）
  - 行为：`TRUST_PROXY=1` 只信任配置的代理 CIDR，取最右非受信地址；15 分钟内 IP+账号失败 5 次锁定 15 分钟；账号级锁定阈值 50 次且成功登录清除；失败记录每 60 秒清理、上限 10k、优先淘汰过期项；每账号 10 条 `/connector`、全局 1000 条，超出 1013；未 bind socket 全局 2000、单 IP 100、30 秒超时；WS `maxPayload` 1 MiB、100 帧/秒，超出 1008；REST body 1 MiB、仅 `application/json`；`sameOrigin` 对 `/api/desktop/login` 放行无 Origin 请求。
  - 测试：`relay/test/limits.test.js`（XFF 伪造、锁定、连接数、未 bind、帧超限、Origin 例外）。
  - 验证：`cd relay && npm test -- --test-name-pattern="limit|forwarded|frame|connector|origin"`。
  - 证据：测试输出。

- [ ] **2.4 SSE 背压、cancel 与重连风暴**
  - 文件：
    - `relay/src/index.js`（SSE 每设备 4 客户端、有界队列与断开）
    - `relay/src/connector.js`（cancel 转发、generation 计数）
    - `relay/src/protocol.js`（`MSG.cancel`）
    - `ds-bot/src/shared/relay-protocol.js`（`MSG.cancel`）
    - `ds-bot/src/host/relay.js`（`AbortController`）
  - 行为：每 deviceId 最多 4 个 SSE；`res.write()` 返回 false 暂停；事件进入有界队列；累计 4 MiB 或 30 秒未 drain 断开；手机断开/取消发 `cancel`，connector 用 `AbortSignal` 结束 `rt.handle`；旧 socket close 不安排重连；协议为 v2。
  - 测试：`relay/test/stream.test.js`（慢消费者、每设备上限、cancel、重连去重）。
  - 验证：`cd relay && npm test -- --test-name-pattern="sse|slow|cancel|reconnect"`。
  - 证据：测试输出。

- [ ] **2.5 安全响应头、静态缓存与版本清理**
  - 文件：
    - `relay/src/static.js`
    - `relay/src/index.js`
    - `scripts/prune-web-dist.mjs`（新建）
    - `relay/scripts/sync-web.mjs`（发布后调用 prune）
  - 行为：HTML 加 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`X-Frame-Options: DENY`；哈希资源 `public, max-age=31536000, immutable`；`index.html` `no-store`；HTML/JS/CSS/JSON gzip；SSE 不压缩；保留最近 2 个 Web Shell 版本，并在发布/部署流程实际调用清理脚本。
  - 测试：`relay/test/static.test.js`、`scripts/prune-web-dist.test.mjs`。
  - 验证：`cd relay && npm test -- --test-name-pattern="header|cache|static|gzip|prune"`。
  - 证据：测试输出与响应头断言。

- [ ] **2.6 Android 明文与 WebView 安全**
  - 文件：
    - `android/app/src/main/AndroidManifest.xml`（release `usesCleartextTraffic=false`）
    - `android/app/src/debug/AndroidManifest.xml`（新建，允许本地明文）
    - `android/app/src/main/java/**`（关闭 file access 与 mixed content）
  - 验证：`cd android && gradle --no-daemon assembleRelease` 后检查合并后的 manifest。
  - 证据：`android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml` 片段。

## 3. ds-bot 侧安全与协议兼容

- [ ] **3.1 cancel 帧与 AbortSignal 端到端**
  - 文件：
    - `ds-bot/src/host/relay.js`
    - `ds-bot/src/shared/relay-protocol.js`
    - `ds-bot/src/host/channel.js`
  - 行为：收到 `cancel` 时通过 `AbortController` 终止对应 `rt.handle`；取消后不再发送 response；未知 request id 忽略。
  - 测试：`ds-bot/test/relay-cancel.test.js`。
  - 验证：`cd ds-bot && npm test -- --test-name-pattern="cancel|relay"`。
  - 证据：测试输出。

- [ ] **3.2 连接器重连去重**
  - 文件：`ds-bot/src/host/relay.js`
  - 行为：generation 计数；只有当前 socket close 才重连；已有活跃 socket 不重建；退避去重。
  - 测试：`ds-bot/test/relay-reconnect.test.js`。
  - 验证：`cd ds-bot && npm test -- --test-name-pattern="reconnect|relay"`。
  - 证据：测试输出。

- [ ] **3.3 手机端点默认拒绝白名单**
  - 文件：
    - `ds-bot/src/shared/relay-protocol.js`
    - `relay/src/protocol.js`
  - 允许：`state`、`models`、`efforts`、`thinking`、`exchange`、`exchange-text`、`file-text`、`earlier`、`chat`、`send`、`resume`、`run-stats`、`usage`、`room-progress`、`create-bot`、`update-bot`、`delete-bot`、`set-main`、`set-prefs`、`duplicate-bot`、`create-room`、`update-room`、`delete-room`、`add-agent`、`remove-agent`、`agent-session`、`agent-adopt`、`agent-archive`、`agent-rename`、`set-flags`、`approval-answer`、`dismiss-question`、`dismiss-view`、`stop-member-work`、`stop-room-work`、`goal-draft`、`goal-control`、`avatar-library`、`avatar-import`、`avatar-delete`、`folders`、`folder-list`、`team-workspace`、`private-release`、`memory-history`、`memory-restore`、`learning-answer`、`new-room-conversation`、`duplicate-room`。
  - 拒绝：`providers`、`provider-*`、`secret-*`、`capability-*`、`connector-*`、`relay-*`、`diagnostics*`、`folder-pick`、`update-install`、`dsh-update-install`。
  - 测试：`relay/test/allowlist.test.js`（表驱动允许/拒绝，双端常量一致）。
  - 验证：`cd relay && npm test -- --test-name-pattern="allow|forbid|endpoint"`。
  - 证据：白名单与测试输出。

## 4. 群聊与记忆采用官方实现

- [ ] **4.1 采用官方群聊引擎**
  - 文件：
    - `ds-bot/src/host/groups.js`、`turns.js`、`parts.js`、`roster.js`、`delivery.js`、`goals.js`
    - 对应官方测试
  - 操作：以 `71d344bf` 版本整体覆盖；删除 fork 的 `relaySessionOf`/`roomBySession` 与旧群聊补丁；改用 `sessionOfRoom`/`roomOwners`。如果本地缺失某些模块（如 `goals.js`），按“新增”处理而不是“替换”。
  - 验证：
    - `cd ds-bot && npm test -- --test-name-pattern="group|turn|delivery|goal|roster"`
    - `rg "relaySessionOf|roomBySession|room-chat|roomPage" ds-bot/src` 无生产代码命中
  - 证据：测试输出与搜索输出。

- [ ] **4.2 群聊在桌面与手机可见**
  - 文件：
    - `ds-bot/src/client/`（官方群聊视图）
    - `app/ui/src/chat.js`（保留官方没有的桌面窗口增强）
    - `web/`（复用同一组件）
  - 行为：打开群显示历史消息、发送者、实时进度；手机发送进入当前群会话；不维护第二套群聊读取。
  - 验证：
    - `cd web && npm run build`
    - 手工：桌面与手机各打开一个群，确认历史与新消息。
  - 证据：构建输出与手工验证截图/记录。

- [ ] **4.3 新群会话与复制群增量**
  - 文件：
    - `ds-bot/src/host/channel.js`（`new-room-conversation`、`duplicate-room`）
    - `ds-bot/src/client/group-settings.js`（入口）
    - 对应测试
  - 行为：新会话保留群名/成员/设置/记忆，归档旧会话并生成新 `room.sessionId`；复制群复制成员与设置，不复制会话与记忆；不修改官方 turn 流程。
  - 测试：`ds-bot/test/room-conversation.test.js`、`ds-bot/test/duplicate-room.test.js`。
  - 验证：`cd ds-bot && npm test -- --test-name-pattern="conversation|duplicate"`。
  - 证据：测试输出。

- [ ] **4.4 官方记忆历史/恢复与学习提议**
  - 文件：
    - `ds-bot/src/host/memory.js`、`learning.js`、`privacy.js`
    - `ds-bot/src/client/`（`learning-card.js`、相关卡片）
    - `ds-bot/src/host/channel.js`（`memory-history`、`memory-restore`、`learning-answer`）
  - 行为：记忆历史显示时间/来源/内容并支持单条恢复；恢复冲突不静默覆盖；学习提议空闲触发、限频、批准后落盘、拒绝后记住；群记忆只对当前成员可见；提议与日志不含密钥。注意：官方 `privacy.js` 是私聊边界，密钥脱敏来自 `secrets.js` 的 `redactSecrets`，不要混用。
  - 测试：`ds-bot/test/memory.test.js`、`ds-bot/test/learning.test.js`、`ds-bot/test/privacy.test.js`。
  - 验证：`cd ds-bot && npm test -- --test-name-pattern="memory|learning|privacy|secret"`。
  - 证据：测试输出。

- [ ] **4.5 手机侧记忆/学习入口**
  - 文件：
    - `relay/src/protocol.js`（白名单）
    - `ds-bot/src/shared/relay-protocol.js`
    - `web/`（展示与交互）
  - 行为：手机调用 `memory-history`、`memory-restore`、`learning-answer` 转发到桌面；不需要额外凭证；错误信息不含 token/key。
  - 验证：`cd relay && npm test -- --test-name-pattern="allow|memory|learning"`。
  - 证据：测试输出与手工验证记录。

## 5. 工程实践

- [ ] **5.1 CI 覆盖四个包、结果门禁与安全扫描**
  - 文件：`.github/workflows/test.yml`、`.github/workflows/android.yml`
  - 行为：新增/调整 `ds-bot`、`app`、`relay`、`web` job；把 relay/web/security 加入最终 `result` 的 `needs` 与断言；保留泄漏扫描 `node scripts/scan.mjs <path>`；失败显示包名与 job。
  - 验证：
    - `ruby -e "require 'yaml'; YAML.load_file('.github/workflows/test.yml')"`
    - `grep -n "needs:" .github/workflows/test.yml` 确认新 job 进入 gate
  - 证据：workflow 文件差异与运行链接（或本地验证记录）。

- [ ] **5.2 设计文档与 CHANGELOG**
  - 文件：
    - `docs/plans/2026-11-05-upstream-sync.md`（新建）
    - `CHANGELOG.md`（新建或更新）
  - 行为：记录本次架构决策、退役项、迁移与回滚步骤；CHANGELOG 使用 Keep a Changelog，每条挂任务 ID。
  - 验证：人工检查条目与任务 ID 对应。
  - 证据：文件路径与条目摘要。

- [ ] **5.3 版本号、manifest 与 Web Shell 同步**
  - 文件：`app/package.json`、`ds-bot/package.json`、`relay/package.json`、`web/package.json`、`web/manifest.json`
  - 行为：统一 `0.3.0`；包名保持 `@lininn/ds-bot`；运行 `node relay/scripts/sync-web.mjs 0.3.0` 生成 `relay/web-dist/0.3.0` 并写入匹配 manifest。
  - 验证：
    - `node -e "for (const p of ['app','ds-bot','relay','web']) console.log(p, require('./'+p+'/package.json').version)"`
    - `node -e "console.log(require('./web/manifest.json').version)"`
    - `ls relay/web-dist`
  - 证据：版本输出与目录列表。

- [ ] **5.4 行为命名测试与拒绝路径补齐**
  - 文件：各包 `test/` 下新增用例
  - 行为：安全行为（会话、重启、设备、复制 relay.json、限流、背压、取消、协议 v1 拒绝）、迁移、拒绝路径均有行为命名测试。
  - 验证：`cd ds-bot && npm test`、`cd app && npm test`、`cd relay && npm test`。
  - 证据：测试清单与通过输出。

## 6. 全量验证与交付

- [ ] **6.1 完整测试矩阵**
  - 验证：
    - `cd ds-bot && npm run harness && npm test && npm run lint`
    - `cd ds-bot && node scripts/build-client.mjs --check`
    - `cd app && npm test`
    - `cd relay && npm test`
    - `cd web && npm run build`
    - `node scripts/scan.mjs .`
  - 证据：逐条命令与结果，失败项必须说明原因。

- [ ] **6.2 迁移演练**
  - 操作：用当前 `main` 的 `state.json` 副本启动新基线，确认 Bot/群/记忆/设置保留，生成备份，日志记录被删除设置；确认手机与桌面各需要一次重新登录/配对。
  - 验证：备份文件存在；启动后关键集合数量与迁移前一致；恢复备份可回到旧版本。
  - 证据：迁移前后计数、日志片段与重新登录提示记录。

- [ ] **6.3 桌面与手机手工验证**
  - 操作：桌面安装/升级/卸载；手机登录/发消息/群聊/记忆/审批；旧 v1 桌面连接器观察 4003 提示。
  - 验证：见 `specs/engineering-practices/spec.md` 的发布检查场景。
  - 证据：手工记录与截图（脱敏）。

- [ ] **6.4 发布证据与回滚说明**
  - 文件：`docs/plans/2026-11-05-upstream-sync.md`（补验证记录）、`CHANGELOG.md`
  - 行为：记录测试、构建、安装、手机验证结果；写明回滚到 `main` 0.2.15 的步骤。
  - 验证：人工检查证据完整。
  - 证据：文档链接与摘要。

- [ ] **6.5 晋级 `main`（需用户单独确认）**
  - 前置：6.1–6.4 全部通过。
  - 操作：向用户确认后，把 `main` 指向 `sync/upstream-v0.2.7` 的验证提交；旧 `c6135ea` 保留可回滚。
  - 验证：
    - `git log --oneline -1 main` 指向新基线提交
    - `git branch --contains c6135ea` 仍可找到回滚点
  - 证据：用户确认记录、`main` 新 SHA、回滚 SHA。
  - 注意：这是本变更唯一改写 `main` 的操作，未确认不得执行。
