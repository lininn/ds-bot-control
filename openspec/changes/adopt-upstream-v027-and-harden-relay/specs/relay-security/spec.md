# relay-security Specification

## ADDED Requirements

### Requirement: 手机会话不得包含账号凭证

relay SHALL 使用服务端会话表保存登录状态；会话 cookie 只包含随机 session id，不得包含 blog access token。

#### Scenario: 登录后检查 cookie

- **WHEN** 用户通过 `/api/login` 登录成功
- **THEN** `Set-Cookie` 的值是随机 session id
- **AND** cookie 不包含 access token 或可解码的身份信息
- **AND** 生产环境使用 `__Host-relay_session`、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`

#### Scenario: 退出与会话失效

- **WHEN** 用户退出登录或会话空闲超过 24 小时
- **THEN** 服务端删除该 session
- **AND** 后续请求返回 401
- **AND** 该 session 的 SSE 与已绑定 connector 连接被关闭

#### Scenario: relay 重启

- **WHEN** relay 进程重启
- **THEN** 未过期且未吊销的手机会话仍然有效
- **AND** 磁盘上只保存 `sha256(sessionId)`，不保存可直接使用的 session id

### Requirement: 桌面连接器必须使用独立设备凭证

relay SHALL 在桌面登录成功后签发设备凭证，桌面只保存该凭证；账号 access token 不得下发给手机或写入手机会话。

#### Scenario: 持久化目录可写

- **WHEN** relay 以 systemd `ProtectSystem=strict` 运行
- **THEN** `DSBOT_RELAY_DATA` 目录通过 `StateDirectory` 或 `ReadWritePaths` 可写
- **AND** 会话与设备注册表可以原子写入
- **AND** 写入失败时拒绝启动而不是静默丢失凭证

#### Scenario: 首次桌面登录

- **WHEN** 桌面调用 `/api/desktop/login` 并验证 blog token 成功
- **THEN** relay 返回一次性设备凭证
- **AND** 设备注册表保存 `tokenHash`、`deviceId`、`machineId`，不保存明文 token

#### Scenario: 设备凭证被吊销

- **WHEN** 用户在设置中吊销某台设备
- **THEN** 该设备的 connector 连接被关闭
- **AND** 该设备相关的手机 SSE 流被关闭
- **AND** 再次连接返回 4001

#### Scenario: 同账号设备顶替

- **WHEN** 同一 `deviceId` 使用不同凭证或不同 `machineId` 连接
- **THEN** 新连接被拒绝（4002）
- **AND** 已在线设备不被踢下线

#### Scenario: 复制 relay.json

- **WHEN** 用户把一台机器的 `relay.json` 复制到另一台机器
- **THEN** 连接器在启动时重新计算本机 `machineId` 并随 bind 发送
- **AND** relay 因 `machineId` 与注册表不符而拒绝连接
- **AND** 不读取 `relay.json` 中保存的旧 `machineId` 冒充原机

#### Scenario: 旧版连接器

- **WHEN** `RELAY_PROTOCOL = 1` 的连接器连接 v2 relay
- **THEN** relay 以 4003 关闭连接
- **AND** 返回明确的“请升级桌面客户端”提示
- **AND** 不使用旧 access token 绑定

### Requirement: 登录与连接必须有限流

relay SHALL 按真实客户端 IP 与账号双维度限流，并限制 connector 与 WebSocket 资源。

#### Scenario: 反代后的真实 IP

- **WHEN** `TRUST_PROXY=1` 且请求来自配置的受信代理 CIDR
- **THEN** 限流从 `X-Forwarded-For` 右侧向左跳过受信代理，取第一个非受信地址
- **AND** 客户端伪造的最左侧 XFF 值不影响限流键
- **AND** 非受信来源的 XFF 被忽略

#### Scenario: 暴力尝试锁定

- **WHEN** 同一 IP + 账号在 15 分钟内失败 5 次
- **THEN** 该组合锁定 15 分钟
- **AND** 锁定期间即使密码正确也返回 429
- **AND** 攻击者无法仅凭他人用户名触发账号级全局锁定；账号级锁定阈值更高（50 次）且成功登录会清除

#### Scenario: 连接数上限

- **WHEN** 某账号已有 10 条 connector 连接
- **THEN** 第 11 条以 1013 关闭
- **AND** 全局超过 1000 条时同样拒绝
- **AND** 未完成 bind 的 socket 受全局 2000 条、单 IP 100 条、30 秒 bind 超时限制

#### Scenario: WebSocket 超限

- **WHEN** 单帧超过 1 MiB 或单连接超过 100 帧/秒
- **THEN** 连接以 1008 关闭

### Requirement: 长连接必须有资源边界

relay SHALL 对 SSE 慢消费者做背压保护，并在手机断开时取消桌面请求。

#### Scenario: 慢消费者

- **WHEN** 某个手机 SSE 连接累计待写缓冲超过 4 MiB 或 30 秒未 drain
- **THEN** relay 断开该 SSE 连接
- **AND** 事件进入每客户端有界队列，而不是无界数组
- **AND** relay 内存不随该客户端无界增长

#### Scenario: 每设备 SSE 上限

- **WHEN** 同一桌面设备已有 4 个手机 SSE 客户端
- **THEN** 第 5 个客户端被拒绝
- **AND** 上限按 deviceId 计算，而不是按手机 session 计算

#### Scenario: 手机取消请求

- **WHEN** 手机断开或主动取消某个 `request`
- **THEN** relay 向 connector 发送 `cancel` 帧
- **AND** connector 通过 `AbortSignal` 结束对应处理

#### Scenario: 重连风暴

- **WHEN** 旧 WebSocket 在已有新连接时触发 close
- **THEN** connector 不为旧 socket 安排新的重连
- **AND** 活跃连接保持不变

### Requirement: 静态资源与 Android 必须有默认安全配置

relay SHALL 为自绘页面发送安全响应头；Web Shell 的哈希资源可缓存，入口文件不缓存；Android release 构建默认拒绝明文 HTTP。

#### Scenario: 安全响应头

- **WHEN** 请求 relay 的 HTML 页面
- **THEN** 响应包含 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`X-Frame-Options`

#### Scenario: 静态缓存

- **WHEN** 请求 `/web-dist/<ver>/assets/<hashed-file>`
- **THEN** 返回 `Cache-Control: public, max-age=31536000, immutable`
- **AND** `index.html` 返回 `no-store`

#### Scenario: Android 明文

- **WHEN** 构建 release APK
- **THEN** `usesCleartextTraffic` 为 false
- **AND** 只有 debug 构建允许明文

#### Scenario: 旧 Web Shell 清理

- **WHEN** 发布新版本且 `web-dist` 中存在旧版本目录
- **THEN** 清理脚本保留最近 2 个版本
- **AND** 被清理版本不再对外提供服务
- **AND** 回滚所需的上一版本仍在保留范围内

### Requirement: 现有账号登录必须保持可用

安全改造 SHALL 保留 blog `/api/relay/auth` 与 `/api/desktop/login` 的现有登录方式，不要求用户改用二维码或密钥配对。

#### Scenario: 老用户重新登录

- **WHEN** 老用户升级后打开手机页面
- **THEN** 使用原 blog 账号密码完成登录
- **AND** 旧会话失效时得到明确的重新登录提示
