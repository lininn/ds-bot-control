# upstream-baseline Specification

## ADDED Requirements

### Requirement: 新基线必须从官方 v0.2.7 重建

系统 SHALL 从 `upstream/main` 的 `71d344bf` 建立 `sync/upstream-v0.2.7` 分支，且不得 merge 本地 `main`、官方 `dev` 或任何无共同祖先的历史。

#### Scenario: 建立新基线

- **WHEN** 执行基线迁移
- **THEN** `sync/upstream-v0.2.7` 的起点是 `71d344bf`
- **AND** `git merge-base main sync/upstream-v0.2.7` 仍为空
- **AND** `main` 分支未被改写

#### Scenario: 拒绝 merge 历史

- **WHEN** 实施者尝试把 `main` 或 `upstream/dev` merge 进新分支
- **THEN** 流程必须失败并提示改用逐提交重放

### Requirement: fork 独有层必须保留

新基线 SHALL 保留 `relay/`、`web/`、`android/`、`ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、macOS 安装器与 Host 心跳，并保持 `@lininn/ds-bot` 包名。

#### Scenario: 分支包含远程控制

- **WHEN** 检查新基线的文件树
- **THEN** 上述目录与文件都存在
- **AND** `ds-bot/package.json` 的包名仍为 `@lininn/ds-bot`

#### Scenario: 桌面应用仍可构建

- **WHEN** 在 `app/` 运行 `npm test` 和 `npm run dist`
- **THEN** 构建成功并产出可安装包

### Requirement: 本地提交必须按策略重放

系统 SHALL 只重放仍然需要的本地提交，跳过发布/版本提交、merge 提交和生成的 `ds-bot/client.js`，并在重放后重新生成 client bundle。

#### Scenario: 跳过发布提交

- **WHEN** 重放 `d540a544`、`dce6402f`、`2e6819ee`、`4e242d97`
- **THEN** 不直接 cherry-pick 这些发布提交
- **AND** 只取其中仍需的配置修正

#### Scenario: 重新生成 client bundle

- **WHEN** 重放完成
- **THEN** 运行 `node scripts/build-client.mjs`
- **AND** `node scripts/build-client.mjs --check` 通过

### Requirement: relay 集成点必须恢复

系统 SHALL 在官方 `channel.js` 上恢复 `rt.handle = handle`、`relay-status`、`relay-login`、`relay-logout`、`relay-reconnect`，并在 `feed.js` 恢复 `subscribeFeed`。

#### Scenario: 手机可以访问 relay 控制端点

- **WHEN** 手机或桌面设置页调用 `relay-status`
- **THEN** 该端点被分发到 fork 的 relay 控制器
- **AND** 不需要恢复已删除的 `room-continue`

#### Scenario: 手机可以订阅实时 feed

- **WHEN** relay 为某个设备订阅 feed
- **THEN** 桌面端通过 `subscribeFeed` 收到事件并转发

### Requirement: 冲突实现必须退役

系统 SHALL 删除 `room-continue`、`relayLimit`、`relayLimitDefault`、`room-chat`，并用官方 `sessionOfRoom` / `roomOwners` 替代 `relaySessionOf` / `roomBySession`。

#### Scenario: 不再存在旧端点

- **WHEN** 搜索 `room-continue`、`relayLimit`、`room-chat`
- **THEN** 生产代码中不再存在这些符号
- **AND** 相关 UI 与测试已同步删除或改写

#### Scenario: 群聊使用官方读取路径

- **WHEN** 桌面或手机打开群聊
- **THEN** 使用官方 `roomsById` / `sessionId` / feed 读取
- **AND** 不依赖 fork 的 `roomPage`

### Requirement: 新基线必须晋级为发布主线

系统 SHALL 在全量验证通过后，经用户明确确认把 `main` 指向新基线；未确认时不得改写 `main`。

#### Scenario: 发布晋级

- **WHEN** `sync/upstream-v0.2.7` 的全部验证通过
- **THEN** 用户明确确认后，`main` 指向新基线
- **AND** 发布 tag 指向 `main` 上的提交
- **AND** 旧 `main` 的提交 `c6135ea` 仍可访问用于回滚

#### Scenario: 未确认晋级

- **WHEN** 验证未完成或用户未确认
- **THEN** `main` 保持不变
- **AND** 不从新基线执行发布

### Requirement: 数据迁移必须可回滚

系统 SHALL 在首次以新基线启动时备份 `state.json`，保持 state 版本 1，并保留无法识别的顶层字段；被删除的 relay 设置必须记录在迁移日志中。

#### Scenario: 从 0.2.15 升级

- **WHEN** 新版本读取旧 `state.json`
- **THEN** Bot、群、记忆、模型设置不丢失
- **AND** 生成 `state.json.bak-<timestamp>`
- **AND** 迁移日志列出被删除的 `relayLimit`/`relays` 设置

#### Scenario: 迁移失败

- **WHEN** 迁移过程中抛出错误
- **THEN** 原 `state.json` 不被覆盖
- **AND** 用户可从备份恢复
