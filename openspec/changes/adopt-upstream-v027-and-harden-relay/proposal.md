# 提案：以官方 v0.2.7 为新基线，保留远程控制并完成安全与工程实践升级

## Why

本 fork 的群聊、记忆、学习、桌面体验已经落后官方 v0.2.3 之后 535 个提交；同时 fork 独有的 relay/web/android 远程控制存在明确的信任边界问题。继续在 0.2.15 上逐功能打补丁，会形成“0.2.3 外壳 + 0.2.7 内核”的混合状态，后续每次同步成本更高。

本变更的目标是一次性把主线拉回官方 **v0.2.7（71d344bf）**，在其上重放 fork 自研能力，再完成安全加固、官方群聊/记忆落地和工程实践对齐。

## What Changes

### A. 换基线（P0，前置）

- 从 `upstream/main` 的 **71d344bf** 新建 `sync/upstream-v0.2.7` 分支，不 merge 无共同祖先的历史。
- 保留 fork 独有层：`relay/`、`web/`、`android/`、`ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、macOS 安装器与 Host 心跳。
- 重放本地 20 个非 merge 提交中仍然需要的部分，跳过发布/版本提交、merge 提交 `a6bbb593` 和生成物 `ds-bot/client.js`。
- 恢复集成点：`rt.handle`、relay 端点与白名单、`feed.subscribeFeed`、`deep-view` 依赖、版本化 Web Shell 分发。
- 退役被官方取代的实现：`relaySessionOf/roomBySession`、`room-continue`、`relayLimit` 及其设置。
- state 版本保持 1；迁移前备份 `state.json`，不丢失未知字段。

### B. 安全加固（保留现有账号登录）

- relay 会话改为服务端会话表：cookie 只放随机 session id，不放账号 access token；支持吊销、轮换、空闲过期。
- 桌面连接器使用 relay 签发的独立设备凭证，手机永远拿不到账号级 token；设备凭证可单独吊销。
- 限流：可信代理下发真实 IP、按账号锁定、失败记录可清理；限制 `/connector` 连接数与 WebSocket 帧大小/速率。
- 可靠性：SSE 背压与慢消费者断开；手机断开通过 `cancel` 帧传递 `AbortSignal`；修复旧 socket 关闭触发的重连风暴。
- 响应头与静态资源：relay 自绘页补 CSP；哈希资源可缓存；静态压缩；旧版本目录可清理。
- Android：默认禁止明文 HTTP，调试构建才允许本地明文。

### C. 群聊与记忆采用官方实现

- 群聊引擎直接使用官方 `groups.js`、`turns.js`、`parts.js`、`roster.js`、`delivery.js` 及其测试；不再保留 fork 的旧群聊补丁。
- 群目标 `goals.js`、群记忆只给当前成员等官方行为随基线生效。
- 记忆历史/恢复、学习提议（技能与 AGENTS.md）随基线生效；补齐手机的端点白名单与 Web Shell 展示。
- fork 独有的“新群会话 / 复制群”如官方未提供，作为独立增量移植，不修改官方群聊引擎。

### D. 工程实践

- CI 覆盖 `ds-bot`、`app`、`relay`、`web`；保留泄漏扫描、打包安装/升级/卸载检查。
- 本变更及后续变更使用 `docs/plans/` 设计文档和 Keep a Changelog 形式的 CHANGELOG。
- 新增/修改行为必须有行为命名的测试；提交验证命令与证据。
- 明确版本号策略，避免本地 0.2.15 与官方 0.2.7 的语义冲突。

## 验收标准

### A. 换基线

- [ ] `sync/upstream-v0.2.7` 从 71d344bf 出发，包含 relay/web/android 与本地必要修复。
- [ ] `ds-bot` 测试、lint、client 构建检查通过；`app` 测试通过；`relay` 测试通过；`web` 构建通过。
- [ ] 桌面应用能启动，远程控制能登录、选设备、收发消息。
- [ ] 手机能打开群聊、私聊、记忆、审批卡片；Web Shell 与 relay 版本匹配。
- [ ] state 从 0.2.15 升级后，Bot、群、记忆、设置不丢失；`state.json` 有迁移前备份。
- [ ] 全量验证通过后，经用户确认把 `main` 晋级到新基线；未确认不改写 `main`。

### B. 安全

- [ ] 手机 session cookie 中不含 access token；数据库/内存中只存 session id 与最小身份。
- [ ] 退出登录立即失效；过期/吊销的会话被拒绝。
- [ ] 同账号第二台设备不能顶掉已绑定的同名设备；设备可单独吊销。
- [ ] 反代后限流按真实 IP/账号生效；暴力尝试会锁定并自动解锁。
- [ ] 慢消费者不会导致 relay 内存无界增长；断开手机能取消桌面正在执行的请求。
- [ ] WS 超限帧被拒绝；旧 socket 关闭不会新建重复连接。
- [ ] 安全头、缓存、压缩、旧版本清理生效；Android 默认拒绝明文 HTTP。

### C. 群聊/记忆

- [ ] 官方群聊测试全部通过；本地旧群聊补丁已移除或改写为不冲突的增量。
- [ ] 群目标、群记忆成员范围、记忆历史/恢复、学习提议在桌面和手机上可见可用。
- [ ] relay 端点白名单包含新端点，且不暴露桌面专属危险端点。

### D. 工程实践

- [ ] CI 覆盖四个包；失败能定位到包。
- [ ] CHANGELOG、docs/plans、测试命名和验证证据齐全。
- [ ] 版本号策略文档化。

## 边界（Out of scope）

- 不采用官方 `feat/mobile-link` 的 Expo 原生 App / Noise 配对；本轮保留账号登录 + WebView。
- 不引入 IM、连接器、本地 Agent、电脑操控。
- 不升级到 DSH 0.2.2-rc.1。
- 不改变 blog 登录服务本身；不新增第三方身份提供方。
- 不 merge 官方 dev/develop，不 merge 无共同祖先的历史。
- 不做 npm 发布动作。

## 风险

- **重放冲突**：本地 20 个提交中，群聊 session、client UI、app 启动流程与官方改动重叠；必须先整体采用官方模块，再移植 fork 增量。
- **app 壳差异**：官方 `app/src/main.mjs` 已重写为 start-window/whale 架构；本地 macOS 安装器与 Host 心跳需要重新接线。
- **端点退役**：`room-continue`、`relayLimit` 删除会影响现有手机页面和用户设置；需要迁移提示。
- **数据迁移**：官方 store 会删除未知的 relay 设置；迁移前备份，未知字段尽量保留。
- **安全迁移**：把 access token 从 cookie 移除会使现有手机会话失效，需要一次性重新登录。
- **版本一致性**：Web Shell 必须与 ds-bot/relay 版本匹配，否则 409；发布流程要一起更新。
- **依赖**：官方 client 引入 `deep-view`，web 构建需要补依赖。

## 决策记录

- 2026-11-05：用户选择“以官方 v0.2.7 为新基线重放本地提交”，而不是在当前 0.2.15 上就地移植。
- 2026-11-05：安全改造保留现有 blog 账号登录，不引入二维码/密钥配对。
- 2026-11-05：本轮不做官方 mobile-link 原生 App；继续维护 WebView + relay 路线。
- 2026-11-05：先完成基线迁移，再在基线上做安全、群聊/记忆和工程实践，避免重复移植。
- 2026-11-05：发布版本使用 `0.3.0`，npm 包名保持 `@lininn/ds-bot`。
- 2026-11-05：relay 协议升级到 v2（bind 使用独立设备凭证）；v1 连接器返回 4003 并要求升级。
- 2026-11-05：手机端点改为默认拒绝白名单，替代现有黑名单。
- 2026-11-05：晋级 `main` 必须单独获得用户确认，`sync/upstream-v0.2.7` 不自动改写 `main`。
