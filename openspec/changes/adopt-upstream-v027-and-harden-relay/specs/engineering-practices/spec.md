# engineering-practices Specification

## ADDED Requirements

### Requirement: CI 必须覆盖全部发布包

CI SHALL 分别验证 `ds-bot`、`app`、`relay`、`web`，并保留泄漏扫描与桌面安装包检查。

#### Scenario: 包级失败可定位

- **WHEN** 某个包的测试或构建失败
- **THEN** CI 显示对应 job 与包名
- **AND** 其他包的 job 不被误判为通过

#### Scenario: relay 与 web 进入 CI

- **WHEN** 提交改动 `relay/` 或 `web/`
- **THEN** relay 测试与 web 构建被执行
- **AND** 两个 job 被加入最终 `result` gate
- **AND** 失败会阻止合并

#### Scenario: 依赖可复现

- **WHEN** CI 对任一包执行 `npm ci`
- **THEN** 该包存在已提交的 `package-lock.json`
- **AND** `web/` 不得以缺失 lockfile 的方式跳过安装

#### Scenario: 泄漏扫描

- **WHEN** 提交包含疑似密钥
- **THEN** `scripts/scan.mjs <目标目录>` job 失败
- **AND** 失败加入最终 `result` gate

### Requirement: 变更必须留下设计与验证记录

每个非平凡变更 SHALL 在 `docs/plans/` 留下设计文档，并在 `CHANGELOG.md` 记录用户可见变化。

#### Scenario: 设计文档

- **WHEN** 变更涉及架构、安全或数据迁移
- **THEN** `docs/plans/` 中存在对应日期的设计文档
- **AND** 文档包含取舍、退役项和回滚步骤

#### Scenario: CHANGELOG

- **WHEN** 变更改变用户可见行为
- **THEN** `CHANGELOG.md` 的 Unreleased 或新版本段落有对应条目
- **AND** 条目引用本变更的任务 ID

### Requirement: 测试必须按行为命名并覆盖拒绝路径

新增或修改的行为 SHALL 有行为命名的测试，至少覆盖正常路径、拒绝路径和兼容/迁移路径。

#### Scenario: 安全行为有测试

- **WHEN** 新增会话、设备、限流、背压或取消逻辑
- **THEN** 存在对应测试文件与用例
- **AND** 用例名描述用户可观察行为

#### Scenario: 迁移有测试

- **WHEN** 修改 state 或协议
- **THEN** 存在从旧版本数据/旧客户端的兼容测试或迁移演练记录
- **AND** `RELAY_PROTOCOL` v1 → v2 的升级拒绝路径有测试（4003 与升级提示）
- **AND** state 迁移有备份、未知字段保留和失败回滚测试

### Requirement: 版本号必须避免与上游冲突

系统 SHALL 在本次基线迁移后的发布中使用 `0.3.0`，并同步 `app`、`ds-bot`、`relay`、`web` 的版本与 Web Shell 目录。

#### Scenario: 版本一致

- **WHEN** 构建发布包
- **THEN** 四个包的版本号一致或按依赖关系明确声明
- **AND** relay 的 `web-dist/<version>` 与 ds-bot 版本匹配
- **AND** `web/manifest.json` 的版本与四包一致
- **AND** 发布前执行 `node relay/scripts/sync-web.mjs <version>` 生成匹配目录

#### Scenario: 回滚

- **WHEN** 新版本需要回滚
- **THEN** relay 保留上一版本 Web Shell
- **AND** 文档说明如何切回

### Requirement: 发布前必须有验证证据

发布 SHALL 附上测试、构建、安装和手机端手工验证记录。

#### Scenario: 发布检查

- **WHEN** 准备发布 0.3.0
- **THEN** 记录各包测试命令与结果
- **AND** 记录桌面安装/升级/卸载与手机登录/发消息/群聊验证
- **AND** 记录 web lockfile、manifest、`web-dist` 版本一致性检查结果

#### Scenario: 发布晋级

- **WHEN** 验证记录完整
- **THEN** 用户明确确认把 `main` 晋级到新基线
- **AND** 发布 tag 从晋级后的 `main` 创建
- **AND** 未确认时不得发布
