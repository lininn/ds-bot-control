# memory-learning Specification

## ADDED Requirements

### Requirement: 记忆历史与恢复必须采用官方实现

系统 SHALL 使用官方 `memory.js` 的变更历史与单条恢复能力，并在桌面和手机提供入口。

#### Scenario: 查看记忆历史

- **WHEN** 用户打开某个 Bot 或群的记忆历史
- **THEN** 显示每条变更的时间、来源和内容
- **AND** 支持恢复单条变更

#### Scenario: 恢复冲突

- **WHEN** 恢复时目标条目已被修改
- **THEN** 按官方策略拒绝或生成冲突提示
- **AND** 不静默覆盖当前记忆

#### Scenario: 手机访问

- **WHEN** 手机调用 `memory-history` 或 `memory-restore`
- **THEN** relay 转发到桌面
- **AND** 不要求手机持有额外凭证

### Requirement: 学习提议必须采用官方实现

系统 SHALL 使用官方 `learning.js` 的技能与 AGENTS.md 提议机制：空闲触发、限频、批准后落盘、拒绝后记住。

#### Scenario: 提议技能

- **WHEN** 一段长工作结束后团队空闲
- **THEN** Bot 可提出新技能建议
- **AND** 只有用户批准后才写入

#### Scenario: 提议 AGENTS.md

- **WHEN** Bot 发现可复用的项目规则
- **THEN** 提出 AGENTS.md 修改
- **AND** 拒绝后相同建议不再重复

### Requirement: 群记忆必须只给当前成员

系统 SHALL 使用官方行为：群记忆只对当前群成员可见，成员退出后不能再读取该群记忆。

#### Scenario: 成员退出

- **WHEN** 一个 Bot 被移出群
- **THEN** 它不能再读取该群记忆
- **AND** 历史消息中的记忆引用不泄露给非成员

### Requirement: 记忆与学习不得泄露密钥

系统 SHALL 在记忆、学习提议和日志中过滤密钥、token 与凭证。

#### Scenario: 提议包含密钥

- **WHEN** 学习提议文本中出现疑似密钥
- **THEN** 提议被拒绝或脱敏
- **AND** 原值不写入记忆、日志或卡片

#### Scenario: 手机日志

- **WHEN** 手机上查看错误或诊断信息
- **THEN** 不显示 access token、设备凭证或 provider key
