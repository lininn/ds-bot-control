# group-engine Specification

## ADDED Requirements

### Requirement: 群聊引擎必须采用官方实现

系统 SHALL 使用官方 v0.2.7 的 `groups.js`、`turns.js`、`parts.js`、`roster.js`、`delivery.js`、`goals.js` 及其测试，不保留 fork 的旧群聊引擎补丁。

#### Scenario: 官方群聊测试通过

- **WHEN** 在 `ds-bot/` 运行 `npm test`
- **THEN** 官方群聊、回合、投递、目标测试全部通过
- **AND** 不存在 fork 的旧 `relaySessionOf` / `roomBySession` 分支逻辑

#### Scenario: 不再维护第二套群聊读取

- **WHEN** 搜索 `room-chat` 与 `roomPage`
- **THEN** 生产代码中不再存在
- **AND** 群聊通过官方 session/feed 读取

### Requirement: 群聊必须在桌面和手机可见

系统 SHALL 在桌面窗口与手机 Web Shell 中显示群聊的当前会话、成员发言和实时进度。

#### Scenario: 打开群聊

- **WHEN** 用户打开一个群
- **THEN** 桌面和手机都显示历史消息与发送者
- **AND** 新消息通过官方 feed 实时出现

#### Scenario: 手机发送群消息

- **WHEN** 用户在手机上向群发送消息
- **THEN** 消息进入当前群会话
- **AND** 群成员按官方引擎规则响应

### Requirement: 新群会话与复制群必须保留

系统 SHALL 提供“新会话”和“复制群”两个增量能力，且不修改官方回合与投递逻辑。

#### Scenario: 新会话

- **WHEN** 用户对群选择“新会话”
- **THEN** 群名、成员、设置、记忆保留
- **AND** 旧会话归档，生成新的 `room.sessionId`
- **AND** 后续消息进入新会话

#### Scenario: 复制群

- **WHEN** 用户选择“复制群”
- **THEN** 新群拥有相同成员和设置
- **AND** 新群没有旧会话和记忆

### Requirement: 群目标行为必须与官方一致

系统 SHALL 使用官方 `goals.js` 的目标、阶段、验收、暂停/恢复/停止/清空行为。

#### Scenario: 设定并推进目标

- **WHEN** 管理员设定目标并启动
- **THEN** 群按阶段推进并显示当前阶段与执行成员
- **AND** 用户可暂停、恢复、停止或清空

#### Scenario: DSH 重启

- **WHEN** DSH 在目标执行期间重启
- **THEN** 目标状态不自动恢复为运行中
- **AND** 用户可手动继续

### Requirement: 群聊端点必须保持手机安全

relay SHALL 只允许手机访问群聊所需的端点，继续拒绝 `secret-*`、`provider-*`、`capability-*`、`connector-*`、`relay-*`、`folder-pick`、`update-install`。

#### Scenario: 手机调用群聊端点

- **WHEN** 手机调用 `create-room`、`update-room`、`send`、`room-progress`、`goal-draft`、`goal-control`、`new-room-conversation`、`duplicate-room`
- **THEN** 请求被转发
- **AND** 这些端点逐项存在于默认拒绝的白名单中
- **AND** 不触发桌面专属端点

#### Scenario: 手机调用危险端点

- **WHEN** 手机调用 `secret-set` 或 `provider-key`
- **THEN** connector 拒绝并返回明确错误
