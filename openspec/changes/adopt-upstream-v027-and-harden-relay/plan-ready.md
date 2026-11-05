# 实现计划：adopt-upstream-v027-and-harden-relay

## 来源
- 项目配置：openspec/config.yaml
- 当前规格：openspec/specs/（当前不存在，全部能力按新规格处理）
- 提案：openspec/changes/adopt-upstream-v027-and-harden-relay/proposal.md
- 设计：openspec/changes/adopt-upstream-v027-and-harden-relay/design.md
- 规格：openspec/changes/adopt-upstream-v027-and-harden-relay/specs/
- 任务：openspec/changes/adopt-upstream-v027-and-harden-relay/tasks.md
- 上游基线：`71d344bf`（v0.2.7）

## Project Context

- 仓库是 DS-Bot fork（`lininn/ds-bot-control`），上游为 `Fei2411/DS-Bot`；上游不是 DeepSeek 官方产品。
- 本地 `main` 与 `upstream/main` 没有共同祖先。基线是官方 v0.2.3（`4a7b5506`）加 fork 初始导入；本地 tag 不代表上游版本，**引用上游一律用 SHA**。
- 技术栈：
  - `ds-bot/`：Node ESM 的 DSH 插件（host + client bundle），纯 JS，不用 TypeScript。
  - `app/`：Electron 44 + Vite 8 + electron-builder。
  - `relay/`：`node:http` + `ws`，账号登录与桌面出站 connector。
  - `web/`：Vite 8 + React 19 手机 Web 壳，复用 `ds-bot/src/client` 与 `app/ui`。
  - `android/`：Gradle WebView 外壳，仓库没有 `gradlew`，使用系统 `gradle`。
- fork 独有层：`relay/`、`web/`、`android/`、`ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、macOS 安装器与 Host 心跳。
- 代码风格：ESM、2 空格、单引号、无分号；注释解释“为什么”；不手工编辑 `ds-bot/client.js`。
- 测试入口：`ds-bot` 先 `npm run harness`，再 `npm test` / `npm run lint` / `node scripts/build-client.mjs --check`；`app` 用 `npm test`；`relay` 用 `npm test`；`web` 用 `npm run build`；仓库级泄漏扫描 `node scripts/scan.mjs <path>`。

## Applicable OpenSpec Rules

来自 `openspec/config.yaml`：

- **specs**：每个能力至少覆盖正常路径、拒绝路径、兼容/迁移三类场景；安全需求写明信任边界、凭证生命周期和失败行为；引用上游必须写 SHA 与文件路径。
- **design**：优先整体采用上游模块，不做半新半旧的局部拼接；relay/web/android 改动必须说明与账号登录、版本握手、静态壳分发的兼容性；列出不可逆决策与回滚点。
- **tasks**：按可独立验证的垂直切片拆分；每个任务写文件范围、验证命令和完成证据；先换基线，再做安全、群聊/记忆、工程实践。
- **implementation**：不修改本变更之外的模块；先读现有实现再改；危险 Git 操作先确认；完成后运行对应包的测试/lint/build 并如实报告未执行项。
- **artifacts**：人类可读产物使用中文；OpenSpec 标题、CLI、代码标识符、协议关键字保持原文。

## Goal

把仓库主线从本地 0.2.15 迁移到官方 v0.2.7 基线，在保留账号登录与远程控制的前提下消除已知 relay 安全缺陷，采用官方群聊与记忆/学习实现，并对齐官方工程实践。

## Non-Goals

- 不采用官方 `feat/mobile-link` 的 Expo 原生 App / Noise 配对。
- 不引入 IM、连接器、本地 Agent、电脑操控。
- 不升级 DSH 到 0.2.2-rc.1。
- 不改变 blog 登录服务；不新增第三方身份提供方。
- 不 merge 官方 dev/develop 或无共同祖先历史。
- 不做 npm 发布。

## Source Coverage

| OpenSpec 来源 | 验收点 | 对应 implementation slice |
|---------------|--------|---------------------------|
| `specs/upstream-baseline` / 新基线从 v0.2.7 重建（起点、merge-base 为空、main 不改写、拒绝 merge） | 分支起点与历史隔离 | Slice 0 |
| `specs/upstream-baseline` / fork 独有层保留（目录/文件、包名、app 可构建） | 目录移植与构建 | Slice 1, Slice 4 |
| `specs/upstream-baseline` / 本地提交按策略重放（跳过发布、重建 bundle、check 通过） | 重放清单与构建检查 | Slice 2, Slice 3 |
| `specs/upstream-baseline` / relay 集成点恢复（`relay-status`、`subscribeFeed`、白名单） | 端点与 feed 恢复 | Slice 3 |
| `specs/upstream-baseline` / 冲突实现退役（无 `room-continue`/`relayLimit`/`room-chat`） | 退役与搜索无命中 | Slice 3, Slice 15 |
| `specs/upstream-baseline` / 新基线晋级为发布主线（用户确认、tag 指向 main、旧提交可回滚） | 晋级流程 | Slice 24 |
| `specs/upstream-baseline` / 数据迁移可回滚（备份、state v1、保留未知字段、日志、失败不覆盖） | 迁移备份与回滚 | Slice 6 |
| `specs/relay-security` / 手机会话不含账号凭证（随机 cookie、生产属性、退出/空闲失效、重启恢复） | 服务端会话生命周期 | Slice 7 |
| `specs/relay-security` / 桌面连接器独立设备凭证（一次性签发、哈希、吊销、4002、复制 relay.json、4003） | 设备注册表与协议 v2 | Slice 8 |
| `specs/relay-security` / 登录与连接限流（受信代理 XFF、失败锁定、连接数、未 bind 上限、WS 帧） | 限流与资源上限 | Slice 9 |
| `specs/relay-security` / 长连接资源边界（每设备 SSE、慢消费者、取消、重连风暴） | 背压、cancel、重连去重 | Slice 10, Slice 13 |
| `specs/relay-security` / 静态与 Android 默认安全（安全头、缓存、旧版本清理、明文） | 响应头、缓存、清理、Android | Slice 11, Slice 12 |
| `specs/relay-security` / 现有账号登录保持可用（blog 账号密码、旧会话重新登录提示） | 登录兼容 | Slice 7, Slice 8, Slice 6 |
| `specs/group-engine` / 群聊引擎采用官方实现（官方测试、无旧符号、无 `room-chat`） | 官方模块覆盖 | Slice 15 |
| `specs/group-engine` / 群聊桌面与手机可见（历史、发送者、feed、手机发送） | 群聊视图与消息流 | Slice 16 |
| `specs/group-engine` / 新群会话与复制群（保留/不复制语义、官方流程不变） | 两个增量端点 | Slice 17 |
| `specs/group-engine` / 群目标与官方一致（阶段、暂停/恢复/停止/清空、重启不自动运行） | 官方 goals 行为 | Slice 15, Slice 16 |
| `specs/group-engine` / 群聊端点手机安全（放行群聊/新会话/复制群、拒绝危险端点） | 默认拒绝白名单 | Slice 14 |
| `specs/memory-learning` / 记忆历史与恢复（时间/来源/内容、单条恢复、冲突不静默、手机转发） | 记忆端点与恢复策略 | Slice 18, Slice 19 |
| `specs/memory-learning` / 学习提议（空闲触发、限频、批准落盘、拒绝记住） | learning 行为 | Slice 18 |
| `specs/memory-learning` / 群记忆只给当前成员（移出后不可读、历史引用不泄露） | 成员范围 | Slice 15, Slice 18 |
| `specs/memory-learning` / 不泄露密钥（提议脱敏、手机诊断不显示 token/key） | 隐私过滤 | Slice 18, Slice 19 |
| `specs/engineering-practices` / CI 覆盖四个包、lockfile 可复现、结果门禁、泄漏扫描 | CI 工作流 | Slice 21 |
| `specs/engineering-practices` / 设计与验证记录（docs/plans、CHANGELOG、取舍/退役/回滚、任务 ID） | 文档产物 | Slice 22 |
| `specs/engineering-practices` / 行为命名测试覆盖拒绝/迁移路径（含 v1→v2） | 测试补齐 | Slice 23 |
| `specs/engineering-practices` / 版本 0.3.0、manifest、web-dist 匹配、保留上一版本 | 版本与发布目录 | Slice 22 |
| `specs/engineering-practices` / 发布前验证证据与晋级确认 | 验证与晋级 | Slice 24 |
| `tasks.md` / 0.1–1.8 | 准备与换基线 | Slice 0–6 |
| `tasks.md` / 2.1–2.6 | relay 安全 | Slice 7–12 |
| `tasks.md` / 3.1–3.3 | ds-bot 安全 | Slice 13, Slice 14 |
| `tasks.md` / 4.1–4.5 | 群聊/记忆 | Slice 14–19 |
| `tasks.md` / 5.1–5.4 | 工程实践 | Slice 21–23 |
| `tasks.md` / 6.1–6.5 | 验证与晋级 | Slice 24 |

## File Responsibility Map

| 文件 | 操作 | 责任 | 相关 slice |
|------|------|------|------------|
| `sync/upstream-v0.2.7`（分支） | create | 新基线 | Slice 0 |
| `web/package-lock.json` | create | 可复现安装 | Slice 0 |
| `relay/`、`web/`、`android/` | copy/modify | fork 独有远程控制层 | Slice 1, 5 |
| `ds-bot/src/host/relay.js` | copy/modify | connector、心跳、设备凭证、cancel、重连 | Slice 1, 3, 8, 10, 13 |
| `ds-bot/src/shared/relay-protocol.js` | copy/modify | 协议 v2、cancel、默认拒绝白名单 | Slice 1, 3, 10, 14 |
| `app/src/install-app.mjs` | copy | macOS 安装器 | Slice 1, 4 |
| `app/src/first-run.mjs`、`host-process.mjs`、`host.mjs` | modify | 仅重放 Host 心跳接线，不整文件覆盖 | Slice 1, 4 |
| `app/src/main.mjs`、`shell.mjs`、`window-frame.mjs` | modify | 对齐官方 start-window 架构 | Slice 4 |
| `ds-bot/src/host/channel.js` | modify | `rt.handle`、relay 端点、新群会话/复制群、记忆/学习端点 | Slice 3, 14, 17, 18 |
| `ds-bot/src/host/feed.js` | modify | 补回 `subscribeFeed` | Slice 3 |
| `ds-bot/src/host/store.js`、`migrate.js` | modify/create | state v1、备份、删除设置日志 | Slice 6 |
| `ds-bot/src/client/relay-settings.js` | modify | 退役设置与重新登录/配对提示 | Slice 6 |
| `ds-bot/src/host/groups.js`、`turns.js`、`parts.js`、`roster.js`、`delivery.js`、`goals.js` | replace/add | 官方群聊引擎 | Slice 15 |
| `ds-bot/src/host/memory.js`、`learning.js`、`privacy.js` | replace/add | 官方记忆/学习/隐私 | Slice 18 |
| `ds-bot/src/client/`（群聊、learning-card 等） | modify/add | 官方客户端视图与卡片 | Slice 15, 16, 18 |
| `app/ui/src/chat.js` | modify | 保留 fork 桌面增强 | Slice 16 |
| `web/`、`web/index.html` | modify | Web Shell 复用官方组件、首帧/下拉刷新 | Slice 5, 16, 19 |
| `relay/src/auth.js` | modify | 登录、服务端会话、设备凭证签发 | Slice 7, 8 |
| `relay/src/sessions.js`、`relay/src/devices.js` | create | 会话/设备持久化 | Slice 7, 8 |
| `relay/src/index.js` | modify | 限流、连接上限、SSE、安全头、静态分发 | Slice 7–11 |
| `relay/src/util.js` | modify | 受信代理 CIDR 与 XFF | Slice 9 |
| `relay/src/connector.js` | modify | cancel、generation 重连 | Slice 10 |
| `relay/src/protocol.js` | modify | `RELAY_PROTOCOL = 2`、`MSG.cancel`、白名单 | Slice 10, 14 |
| `relay/src/static.js` | modify | 缓存、gzip、安全头 | Slice 11 |
| `scripts/prune-web-dist.mjs`、`scripts/prune-web-dist.test.mjs` | create | 保留最近 2 个 Web Shell 版本 | Slice 11 |
| `relay/scripts/sync-web.mjs` | modify | 发布后调用 prune | Slice 11 |
| `relay/README.md` | modify | systemd `StateDirectory`/`ReadWritePaths`、`TRUST_PROXY` | Slice 8, 9 |
| `android/app/src/main/AndroidManifest.xml`、`src/debug/AndroidManifest.xml`、WebView 配置 | modify/create | 默认拒绝明文 | Slice 12 |
| `.github/workflows/test.yml`、`android.yml` | modify | 四包 CI、结果门禁、安全扫描 | Slice 21 |
| `docs/plans/2026-11-05-upstream-sync.md`、`CHANGELOG.md` | create/update | 设计、迁移、回滚、验证记录 | Slice 22, 24 |
| `app/package.json`、`ds-bot/package.json`、`relay/package.json`、`web/package.json`、`web/manifest.json` | modify | 0.3.0、包名、manifest | Slice 22 |
| 各包 `test/` | create/modify | 行为命名测试与拒绝路径 | Slice 23 |

## Implementation Slices

### Slice 0: 准备依赖与隔离基线

- 来源：`tasks.md` 0.1、1.1；`specs/upstream-baseline` 第 1 个 Requirement
- 目标：补齐 `web` lockfile、安装依赖、记录测试基线；从 `71d344bf` 建新分支。
- 依赖：无
- 改动文件：
  - Create: `web/package-lock.json`
  - 分支：`sync/upstream-v0.2.7`
- TDD 计划：不适用；执行命令并记录事实。
- 验证命令：
  - `cd web && npm install --package-lock-only && ls package-lock.json`
  - `cd ds-bot && npm run harness && npm test`
  - `cd app && npm test`
  - `cd relay && npm test`
  - `git merge-base main sync/upstream-v0.2.7` — 预期空
- 完成标准：lockfile 存在；四个包基线结果已记录；分支起点正确。
- 风险/回滚：删除新分支即可；lockfile 可单独回退。

### Slice 1: 移植 fork 独有层

- 来源：`specs/upstream-baseline` 第 2 个 Requirement；`tasks.md` 1.2
- 目标：只把 fork 独有文件带到新基线，官方重写文件走手工重放。
- 依赖：Slice 0
- 改动文件：
  - Copy: `relay/`、`web/`、`android/`、`ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、`app/src/install-app.mjs`
  - Modify: `app/src/first-run.mjs`、`app/src/host-process.mjs`、`app/src/host.mjs`（仅心跳接线）、`ds-bot/package.json`（`deep-view@0.1.0`）
- TDD 计划：
  1. 先加/保留 `ds-bot/test/package-name.test.js` 断言包名。
  2. 移植文件，不复制 `ds-bot/client.js`。
  3. 更新 lockfile 后跑基础测试。
- 验证命令：
  - `git diff --stat 71d344bf -- relay web android ds-bot/src/host/relay.js ds-bot/src/shared/relay-protocol.js app/src/install-app.mjs`
  - `node -e "console.log(require('./ds-bot/package.json').name)"`
- 完成标准：fork 文件存在，包名与依赖正确，官方 app 主流程未被整文件覆盖。
- 风险/回滚：逐文件 `git checkout 71d344bf -- <path>` 回退。

### Slice 2: 按策略重放本地提交

- 来源：`specs/upstream-baseline` 第 3 个 Requirement；`tasks.md` 1.3
- 目标：保留仍有价值的本地改动，跳过发布/版本/merge/生成物。
- 依赖：Slice 1
- 改动文件：按 `design.md` §1.1 清单。
- TDD 计划：
  1. 先保留能描述行为的测试（安装器、relay 重连、群会话）作为回归护栏。
  2. 逐个提交提取 diff，冲突以官方实现为准。
  3. 每完成一类提交运行对应包测试。
- 验证命令：
  - `git log --oneline 71d344bf..sync/upstream-v0.2.7`
  - 对跳过提交用 `git patch-id --stable`/内容 diff 确认未进入
  - `git log --oneline -1 -- ds-bot/client.js`
- 完成标准：重放清单闭环，跳过项可证明未混入。
- 风险/回滚：单提交可用 `git revert` 或重建分支回退。

### Slice 3: 恢复集成点并重新生成 client bundle

- 来源：`specs/upstream-baseline` 第 4、5 个 Requirement；`tasks.md` 1.4、1.5
- 目标：让 relay 控制端点、feed 订阅、默认拒绝白名单在官方 channel/feed 上工作。
- 依赖：Slice 2
- 改动文件：
  - Modify: `ds-bot/src/host/channel.js`、`ds-bot/src/host/feed.js`、`ds-bot/src/shared/relay-protocol.js`
  - Generated: `ds-bot/client.js`（仅构建）
- TDD 计划：
  1. 先加 `ds-bot/test/relay-endpoints.test.js`：`relay-status` 被分发、未知端点不误入。
  2. 实现 `rt.handle = handle` 与端点分支。
  3. 补 `feed.subscribeFeed` 测试，再实现。
  4. 退役 `room-continue`/`relayLimit`/`room-chat` 并跑全量。
- 验证命令：
  - `cd ds-bot && npm run harness && npm test`
  - `cd ds-bot && npm run lint`
  - `cd ds-bot && node scripts/build-client.mjs && node scripts/build-client.mjs --check`
  - `rg "room-continue|relayLimit|room-chat" ds-bot/src relay web app`
- 完成标准：ds-bot 测试/lint/bundle check 全绿，退役符号消失。
- 风险/回滚：`deep-view` 依赖缺失时按 Slice 1 更新 lockfile；回退按文件恢复。

### Slice 4: 桌面 app 启动架构适配

- 来源：`specs/upstream-baseline` 第 2 个 Requirement；`tasks.md` 1.6
- 目标：桌面应用在官方 start-window 架构上启动，保留 mac 安装器与心跳。
- 依赖：Slice 3
- 改动文件：
  - Modify: `app/src/main.mjs`、`app/src/shell.mjs`、`app/src/window-frame.mjs`、`app/src/install-app.mjs`、`app/src/first-run.mjs`、`app/src/host-process.mjs`、`app/package.json`
- TDD 计划：
  1. 先跑 `npm test` 记录基线失败。
  2. 按官方启动流程改写，保留 fork 安装器测试。
  3. 补 Host 心跳启动/停止测试。
- 验证命令：
  - `cd app && npm test`
  - `cd app && npm run dist`
- 完成标准：测试通过、打包成功。
- 风险/回滚：启动流程差异大时先让测试通过再手动启动；可回退单文件。

### Slice 5: Web Shell 与 Android 适配

- 来源：`specs/upstream-baseline` 第 2 个 Requirement；`tasks.md` 1.7
- 目标：Web Shell 复用官方 client 导出，Android 壳可构建。
- 依赖：Slice 3
- 改动文件：`web/`、`web/index.html`、`android/`
- TDD 计划：
  1. 先 `npm run build` 暴露导出/依赖问题。
  2. 修正导入与 `deep-view`。
  3. 保留首帧与下拉刷新。
- 验证命令：
  - `cd web && npm install && npm run build`
  - `cd android && gradle --no-daemon assembleDebug`
- 完成标准：Web 构建成功、Debug APK 产出。
- 风险/回滚：依赖不可用时记录 blocker；回退 web 单目录。

### Slice 6: state 迁移备份与退役提示

- 来源：`specs/upstream-baseline` 第 6 个 Requirement；`tasks.md` 1.8
- 目标：首次启动备份 `state.json`，state v1 兼容，删除设置可追溯，旧会话/设备有明确提示。
- 依赖：Slice 3
- 改动文件：
  - Modify/Create: `ds-bot/src/host/store.js`、`ds-bot/src/host/migrate.js`
  - Modify: `ds-bot/src/client/relay-settings.js`
  - Test: `ds-bot/test/state-migration.test.js`
- TDD 计划：
  1. RED：断言生成 `state.json.bak-<timestamp>`、未知字段保留、日志含 `relayLimit`/`relays`、异常时原文件不变、提示文案存在。
  2. GREEN：实现备份与日志。
  3. REFACTOR：抽出时间戳与日志写入。
- 验证命令：`cd ds-bot && npm test -- --test-name-pattern="migrat|state"`
- 完成标准：五类场景测试通过。
- 风险/回滚：备份失败时中止启动并保留原文件。

### Slice 7: relay 会话持久化与安全 cookie

- 来源：`specs/relay-security` 第 1、6 个 Requirement；`tasks.md` 2.1
- 目标：cookie 只放 session id，服务端可吊销/过期/重启恢复，保留 blog 账号登录。
- 依赖：Slice 5
- 改动文件：
  - Modify: `relay/src/auth.js`、`relay/src/index.js`、`relay/src/config.js`
  - Create: `relay/src/sessions.js`
  - Test: `relay/test/session.test.js`
- TDD 计划：
  1. RED：cookie 不含 `accessToken`、退出 401、空闲 24 小时 401、重启恢复、吊销关闭 SSE/connector、生产 cookie 前缀与 SameSite。
  2. GREEN：实现 `sessions` 表与 `sessions.json`。
  3. REFACTOR：原子写入与过期清理。
- 验证命令：`cd relay && npm test -- --test-name-pattern="session|logout|expire|restart|revoke"`
- 完成标准：cookie 无凭证、吊销/过期/重启行为正确、旧账号登录仍可用。
- 风险/回滚：现有手机会话失效一次，前端提示重新登录；回退 auth/index/sessions。

### Slice 8: 设备凭证、协议 v2 与注册表

- 来源：`specs/relay-security` 第 2、6 个 Requirement；`tasks.md` 2.2
- 目标：桌面使用 relay 签发的一次性设备凭证；可吊销；复制 relay.json 与 v1 连接被拒。
- 依赖：Slice 7
- 改动文件：
  - Modify: `relay/src/auth.js`、`relay/src/config.js`、`ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、`relay/src/protocol.js`、`relay/README.md`
  - Create: `relay/src/devices.js`
  - Test: `relay/test/devices.test.js`
- TDD 计划：
  1. RED：签发一次、哈希存储、吊销后 4001、不同 token/machineId 4002、复制 relay.json 被拒、v1 4003、绑定使用运行时 machineId。
  2. GREEN：实现注册表与常量时间比较。
  3. REFACTOR：原子写入、文件权限 600、systemd 可写目录。
- 验证命令：`cd relay && npm test -- --test-name-pattern="device|revoke|duplicate|protocol|machine"`
- 完成标准：设备生命周期与协议升级测试全绿。
- 风险/回滚：注册表损坏时拒绝启动；凭证不落日志；桌面需重新登录一次。

### Slice 9: 限流、真实 IP、Origin 与连接上限

- 来源：`specs/relay-security` 第 3 个 Requirement；`tasks.md` 2.3
- 目标：反代后按真实 IP/账号限流，限制连接与帧，避免误伤桌面登录。
- 依赖：Slice 7
- 改动文件：
  - Modify: `relay/src/util.js`、`relay/src/index.js`
  - Test: `relay/test/limits.test.js`
- TDD 计划：
  1. RED：伪造最左 XFF 不影响结果、5 次失败锁定、账号级 50 次、连接数 1013、未 bind 上限、帧超限 1008、`/api/desktop/login` 无 Origin 放行。
  2. GREEN：实现受信 CIDR、限流表与清理。
  3. REFACTOR：抽出令牌桶与窗口计数。
- 验证命令：`cd relay && npm test -- --test-name-pattern="limit|forwarded|frame|connector|origin"`
- 完成标准：拒绝路径与 Origin 例外测试通过。
- 风险/回滚：误封时提供开发配置关闭；回退 util/index。

### Slice 10: SSE 背压、cancel 与重连

- 来源：`specs/relay-security` 第 4 个 Requirement；`tasks.md` 2.4
- 目标：每设备 SSE 上限、慢消费者断开、手机断开取消桌面请求、旧 socket 不重连。
- 依赖：Slice 7、Slice 8
- 改动文件：
  - Modify: `relay/src/index.js`、`relay/src/connector.js`、`relay/src/protocol.js`、`ds-bot/src/shared/relay-protocol.js`、`ds-bot/src/host/relay.js`
  - Test: `relay/test/stream.test.js`
- TDD 计划：
  1. RED：第 5 个 SSE 被拒、4 MiB/30 秒断开、有界队列、cancel 帧到达、旧 close 不新建连接。
  2. GREEN：实现缓冲上限与 generation。
  3. REFACTOR：抽出 drain 计时器。
- 验证命令：`cd relay && npm test -- --test-name-pattern="sse|slow|cancel|reconnect"`
- 完成标准：边界测试通过，协议为 v2。
- 风险/回滚：v1 连接已被 4003 拒绝；回退需确认双端兼容。

### Slice 11: 安全头、缓存与版本清理

- 来源：`specs/relay-security` 第 5 个 Requirement；`tasks.md` 2.5
- 目标：自绘页安全头、哈希资源长缓存、入口 no-store、gzip、保留两版本。
- 依赖：Slice 5
- 改动文件：
  - Modify: `relay/src/static.js`、`relay/src/index.js`、`relay/scripts/sync-web.mjs`
  - Create: `scripts/prune-web-dist.mjs`、`scripts/prune-web-dist.test.mjs`
  - Test: `relay/test/static.test.js`
- TDD 计划：
  1. RED：断言安全头、`immutable`、`no-store`、gzip、prune 保留最近 2 个版本。
  2. GREEN：实现头、压缩与清理脚本。
  3. REFACTOR：版本目录保留策略并接入发布流程。
- 验证命令：`cd relay && npm test -- --test-name-pattern="header|cache|static|gzip|prune"`
- 完成标准：响应头、缓存、prune 测试通过，脚本被实际调用。
- 风险/回滚：CSP 过严会挡内联脚本，按自绘页逐条放行；回退 static。

### Slice 12: Android 明文与 WebView

- 来源：`specs/relay-security` 第 5 个 Requirement；`tasks.md` 2.6
- 目标：release 默认拒绝明文，debug 才允许本地明文。
- 依赖：Slice 5
- 改动文件：
  - Modify: `android/app/src/main/AndroidManifest.xml`、`android/app/src/main/java/**`
  - Create: `android/app/src/debug/AndroidManifest.xml`
- TDD 计划：构建后检查合并 manifest；无单元测试时用构建断言。
- 验证命令：
  - `cd android && gradle --no-daemon assembleRelease`
  - 检查 `merged_manifests/release/AndroidManifest.xml`
- 完成标准：release `usesCleartextTraffic=false`，debug 为 true。

### Slice 13: ds-bot cancel 与重连去重

- 来源：`specs/relay-security` 第 4 个 Requirement；`tasks.md` 3.1、3.2
- 目标：AbortSignal 贯穿 host；generation 防重连风暴。
- 依赖：Slice 10
- 改动文件：
  - Modify: `ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、`ds-bot/src/host/channel.js`
  - Test: `ds-bot/test/relay-cancel.test.js`、`ds-bot/test/relay-reconnect.test.js`
- TDD 计划：
  1. RED：cancel 后 response 不再发送；旧 close 不重连；未知 id 忽略。
  2. GREEN：实现 AbortController 与 generation。
  3. REFACTOR：重连退避去重。
- 验证命令：`cd ds-bot && npm test -- --test-name-pattern="cancel|reconnect|relay"`
- 完成标准：两类测试通过。

### Slice 14: 手机端点默认拒绝白名单

- 来源：`specs/group-engine` 第 5 个 Requirement；`specs/relay-security` 第 2 个 Requirement；`tasks.md` 3.3
- 目标：群聊/目标/记忆/学习端点放行，危险端点继续拒绝；两端常量一致。
- 依赖：Slice 3（端点清单可先从 `71d344bf` 审计，不依赖 Slice 15）
- 改动文件：
  - Modify: `ds-bot/src/shared/relay-protocol.js`、`relay/src/protocol.js`
  - Test: `relay/test/allowlist.test.js`
- TDD 计划：
  1. RED：表驱动断言完整允许列表与危险前缀拒绝。
  2. GREEN：实现 `isAllowedEndpoint`，默认拒绝。
  3. REFACTOR：集中常量，避免两处漂移。
- 验证命令：`cd relay && npm test -- --test-name-pattern="allow|forbid|endpoint"`
- 完成标准：每个允许端点有通过用例，每个危险前缀有拒绝用例。
- 风险/回滚：默认拒绝会让遗漏端点不可达；按测试清单逐项补齐。

### Slice 15: 采用官方群聊引擎

- 来源：`specs/group-engine` 第 1、4 个 Requirement；`specs/memory-learning` 第 3 个 Requirement；`tasks.md` 4.1
- 目标：整体采用官方 groups/turns/parts/roster/delivery/goals，删除 fork 旧补丁。
- 依赖：Slice 3
- 改动文件：
  - Replace/Add: `ds-bot/src/host/groups.js`、`turns.js`、`parts.js`、`roster.js`、`delivery.js`、`goals.js`
  - Modify: 引用这些模块的 host/client 文件
  - Test: 官方对应测试
- TDD 计划：
  1. 先跑官方测试，确认基线。
  2. 覆盖/新增模块，删除 `relaySessionOf`/`roomBySession`/`room-chat`/`roomPage`。
  3. 修复引用，跑全量。
- 验证命令：
  - `cd ds-bot && npm test -- --test-name-pattern="group|turn|delivery|goal|roster|memory"`
  - `rg "relaySessionOf|roomBySession|room-chat|roomPage" ds-bot/src`
- 完成标准：官方群聊/目标/成员范围测试通过，旧符号消失。

### Slice 16: 桌面与手机群聊可见

- 来源：`specs/group-engine` 第 2、4 个 Requirement；`tasks.md` 4.2
- 目标：桌面与手机共享官方群聊视图，实时显示消息与进度。
- 依赖：Slice 15
- 改动文件：`ds-bot/src/client/`、`app/ui/src/chat.js`、`web/`
- TDD 计划：
  1. 先为 feed 事件到 UI 的映射加测试（纯函数）。
  2. 接入官方视图。
  3. 手工验证两端。
- 验证命令：
  - `cd web && npm run build`
  - 手工：桌面/手机打开同一个群，发送消息并观察实时更新。
- 完成标准：两端历史与新消息一致，进度可见。

### Slice 17: 新群会话与复制群

- 来源：`specs/group-engine` 第 3 个 Requirement；`tasks.md` 4.3
- 目标：在官方 session 模型上增加两个增量端点，不改 turn 流程。
- 依赖：Slice 15
- 改动文件：
  - Modify: `ds-bot/src/host/channel.js`、`ds-bot/src/client/group-settings.js`
  - Test: `ds-bot/test/room-conversation.test.js`、`ds-bot/test/duplicate-room.test.js`
- TDD 计划：
  1. RED：新会话保留群名/成员/设置/记忆并换 `sessionId`；复制群不复制会话/记忆。
  2. GREEN：实现端点。
  3. REFACTOR：复用官方 `roomOwners`。
- 验证命令：`cd ds-bot && npm test -- --test-name-pattern="conversation|duplicate"`
- 完成标准：两个语义测试通过，官方 turn 测试不回退。

### Slice 18: 官方记忆历史/恢复与学习提议

- 来源：`specs/memory-learning` 第 1、2、3、4 个 Requirement；`tasks.md` 4.4
- 目标：采用官方 memory/learning/privacy，提供历史、恢复、提议与脱敏。
- 依赖：Slice 15
- 改动文件：
  - Replace/Add: `ds-bot/src/host/memory.js`、`learning.js`、`privacy.js`
  - Modify: `ds-bot/src/host/channel.js`、`ds-bot/src/client/`（learning-card 等）
  - Test: `ds-bot/test/memory.test.js`、`learning.test.js`、`privacy.test.js`
- TDD 计划：
  1. RED：历史条目、单条恢复、冲突不覆盖、拒绝后不重复、密钥脱敏、退出成员不可读。
  2. GREEN：接入官方模块与端点；密钥脱敏用 `secrets.js` 的 `redactSecrets`，不要把 `privacy.js` 当脱敏器。
  3. REFACTOR：统一脱敏入口。
- 验证命令：`cd ds-bot && npm test -- --test-name-pattern="memory|learning|privacy|secret"`
- 完成标准：六类行为测试通过。

### Slice 19: 手机侧记忆/学习入口

- 来源：`specs/memory-learning` 第 1、4 个 Requirement；`tasks.md` 4.5
- 目标：手机可查看/恢复记忆、处理学习提议，且不泄露凭证。
- 依赖：Slice 14、Slice 18
- 改动文件：`relay/src/protocol.js`、`ds-bot/src/shared/relay-protocol.js`、`web/`
- TDD 计划：
  1. RED：白名单允许 `memory-history`/`memory-restore`/`learning-answer`；错误信息不含 token。
  2. GREEN：转发与 UI 接入。
  3. REFACTOR：错误脱敏统一。
- 验证命令：
  - `cd relay && npm test -- --test-name-pattern="allow|memory|learning"`
  - 手工：手机查看历史并恢复一条。
- 完成标准：手机可用且无凭证泄露。

### Slice 20: 保留（编号占位，不单独实现）

- 说明：原计划中的 relay 安全已拆到 Slice 7–12；本 slice 不产生改动。

### Slice 21: CI 覆盖四包、结果门禁与安全扫描

- 来源：`specs/engineering-practices` 第 1 个 Requirement；`tasks.md` 5.1
- 目标：CI 分别验证 ds-bot/app/relay/web，保留泄漏扫描，并让失败阻止合并。
- 依赖：Slice 0、Slice 4、Slice 5、Slice 23
- 改动文件：`.github/workflows/test.yml`、`.github/workflows/android.yml`
- TDD 计划：不适用；用 YAML 解析与 gate 断言验证。
- 验证命令：
  - `ruby -e "require 'yaml'; YAML.load_file('.github/workflows/test.yml')"`
  - `grep -n "needs:" .github/workflows/test.yml`
  - 各包本地命令同 Slice 24
- 完成标准：四包 job 存在，relay/web/security 进入最终 `result` gate。
- 风险/回滚：CI 依赖网络与缓存；回退 workflow 文件。

### Slice 22: 设计文档、CHANGELOG 与版本 0.3.0

- 来源：`specs/engineering-practices` 第 2、4 个 Requirement；`tasks.md` 5.2、5.3
- 目标：留下设计/退役/迁移/回滚记录；四包版本、manifest、web-dist 一致。
- 依赖：Slice 5
- 改动文件：
  - Create: `docs/plans/2026-11-05-upstream-sync.md`
  - Create/Update: `CHANGELOG.md`
  - Modify: 四包 `package.json`、`web/manifest.json`
  - Run: `node relay/scripts/sync-web.mjs 0.3.0`
- TDD 计划：加脚本/测试断言四包版本与 manifest、`web-dist` 一致。
- 验证命令：
  - `node -e "for (const p of ['app','ds-bot','relay','web']) console.log(p, require('./'+p+'/package.json').version)"`
  - `node -e "console.log(require('./web/manifest.json').version)"`
  - `ls relay/web-dist`
- 完成标准：全部 `0.3.0`，manifest 与目录匹配，文档含任务 ID。
- 风险/回滚：回退版本字段；发布前统一构建。

### Slice 23: 行为命名测试补齐

- 来源：`specs/engineering-practices` 第 3 个 Requirement；`tasks.md` 5.4
- 目标：安全、拒绝路径、迁移都有行为命名测试。
- 依赖：Slice 6–19
- 改动文件：各包 `test/`
- TDD 计划：汇总各 slice 的 RED 用例，删除重复、补缺口。
- 验证命令：
  - `cd ds-bot && npm test`
  - `cd app && npm test`
  - `cd relay && npm test`
- 完成标准：测试名可读、拒绝路径覆盖。

### Slice 24: 全量验证、发布证据与晋级

- 来源：`specs/engineering-practices` 第 5 个 Requirement；`specs/upstream-baseline` 晋级 Requirement；`tasks.md` 6.1–6.5
- 目标：完整测试矩阵、迁移演练、桌面/手机手工验证、发布证据；用户确认后晋级 `main`。
- 依赖：全部
- 改动文件：`docs/plans/2026-11-05-upstream-sync.md`、`CHANGELOG.md`
- TDD 计划：不适用；执行验证并记录事实。
- 验证命令：
  - `cd ds-bot && npm run harness && npm test && npm run lint`
  - `cd ds-bot && node scripts/build-client.mjs --check`
  - `cd app && npm test`
  - `cd relay && npm test`
  - `cd web && npm run build`
  - `node scripts/scan.mjs .`
- 完成标准：全部命令通过；未执行项写明原因；迁移与手工验证有记录。
- 晋级（需用户单独确认）：
  - 将 `main` 指向 `sync/upstream-v0.2.7` 的验证提交
  - 旧 `c6135ea` 仍可回滚
- 风险/回滚：失败项回到对应 slice；整体回滚到 `main` 0.2.15。

## Verification Plan

- 单元/集成：
  - `cd ds-bot && npm run harness && npm test` — 群聊、turns、记忆、学习、relay cancel/reconnect、state 迁移。
  - `cd relay && npm test` — 会话/重启、设备、协议 v2、限流、SSE、cancel、静态、白名单。
  - `cd app && npm test` — 启动、安装器、Host 心跳。
- 类型/构建：
  - `cd ds-bot && npm run lint`
  - `cd ds-bot && node scripts/build-client.mjs && node scripts/build-client.mjs --check`
  - `cd web && npm install && npm run build`
  - `cd app && npm run dist`
  - `cd android && gradle --no-daemon assembleDebug`
- 安全：
  - `node scripts/scan.mjs .`
  - 响应头/缓存/慢消费者/协议升级断言在 relay 测试中。
- 手动：
  - 桌面安装/升级/卸载。
  - 手机登录（旧账号密码）、发送私聊、打开群聊、查看/恢复记忆、处理学习提议、观察实时进度。
  - 旧 v1 桌面连接器观察 4003 升级提示；复制 `relay.json` 观察拒绝。
  - 反代场景验证 XFF 右侧解析与真实 IP 限流。

## Blockers / Clarifications

- **OpenSpec CLI 不可用**：本机没有 `openspec`，以本文自检替代；完成记录中说明未运行 `openspec validate`。
- **Android SDK/Gradle 环境**：`gradle assembleDebug/Release` 可能因本机缺 SDK 失败；若无法执行必须记录未验证项，不得声称通过。
- **官方 state 字段差异**：官方 store 可能删除 relay 设置；以 Slice 6 的备份 + 日志为准。
- **本地 tag 与上游同名**：任何上游引用必须用 SHA `71d344bf`，禁止使用 `v0.2.7` tag。
- **旧手机会话与桌面凭证失效**：这是安全改造的预期破坏性变更；Slice 6/7/8 必须提供明确提示与重新登录路径。
- **`main` 晋级**：唯一改写 `main` 的操作，执行前必须再次获得用户确认。

## Superpowers Handoff

- `writing-plans` 必须基于本文件生成 `docs/superpowers/plans/2026-11-05-adopt-upstream-v027-and-harden-relay.md`。
- 详细实现计划必须把本文件的 `## Project Context` 与 `## Applicable OpenSpec Rules` 复制/压缩到计划头部或 `## 项目规则` 章节，使 `executing-plans` 无需重新读取 OpenSpec 也能遵守。
- 详细实现计划使用中文：将模板骨架中文化（`Goal`→`目标`、`Architecture`→`架构`、`Tech Stack`→`技术栈`、`File Structure`→`文件结构`、`Project Rules`→`项目规则`、`Task`→`任务`、`Step`→`步骤`、`Self-Review`→`自检`），代码标识符、路径、命令、事件名、OpenSpec 标题和协议关键字保持原文。
- 每个 slice 展开为 2–5 分钟 checkbox 步骤，遵循 RED-GREEN-REFACTOR，附精确验证命令。
- 不得出现 TBD/TODO/“适当处理”/“类似上一步”等占位话术。
- Source Coverage 中的验收点不得省略；实现顺序按 Slice 0 → 24。
- 危险 Git 操作（建分支、复制大树、`git checkout <path>` 覆盖、晋级 `main`）执行前按 Slice 明确范围操作，不触碰 `main`。
