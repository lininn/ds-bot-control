# 以官方 v0.2.7 重建并加固远程控制

- 日期：2026-11-05
- 相关：OpenSpec 变更 `adopt-upstream-v027-and-harden-relay`；上游 `Fei2411/DS-Bot` SHA `71d344bf`（v0.2.7）；旧主线 `c6135ea`（fork 0.2.15）

## 为什么

本地 fork 的起点是官方 v0.2.3 加一次初始导入，之后又独立开发了 relay、手机 Web 壳、Android 壳和远程控制。上游已经推进到 v0.2.7，群聊、Goal、记忆历史/恢复、学习提议和桌面启动结构都换了实现。继续在旧基线上打补丁，会让同一功能存在两套读写路径，也会让安全修复越来越难验证。

这次不 merge 两段没有共同祖先的历史，而是从上游 `71d344bf` 新建 `sync/upstream-v0.2.7`，只重放仍然需要的 fork 文件，再按官方实现重写冲突部分。账号登录方式不变，手机仍然用同一个 blog 账号登录并选择在线电脑。

## 已定的行为

### 基线与发布

- `sync/upstream-v0.2.7` 的起点是上游 SHA `71d344bf`，不是本地同名 tag。`git merge-base main sync/upstream-v0.2.7` 为空。
- `main` 在用户明确确认前保持不动，仍指向 `c6135ea`。晋级是唯一改写 `main` 的操作，旧提交保留作回滚点。
- fork 独有的 `relay/`、`web/`、`android/`、`ds-bot/src/host/relay.js`、`ds-bot/src/shared/relay-protocol.js`、macOS 安装器和 Host 心跳保留；包名仍是 `@lininn/ds-bot`。
- 本地发布版本统一为 `0.3.0`；`web/manifest.json` 与 `relay/web-dist/0.3.0` 必须匹配。relay 保留上一个 Web Shell，未升级的桌面仍可给手机提供旧壳。
- `ds-bot/client.js` 只由 `npm run build` 生成，不手工编辑。

### 远程控制与 relay

- 手机登录继续使用原来的 blog 账号和密码，不新增第三方身份提供方，也不改登录服务。
- 手机只收到随机的服务端 session id。服务端存 `sha256(sessionId)`，有效期 7 天、空闲 24 小时；生产 cookie 名为 `__Host-relay_session`，带 Secure、HttpOnly、SameSite=Lax、Path=/。cookie 不包含 access token。
- 退出登录、吊销会话或账号失效会删除会话，并关闭对应的 live feed；重启后未过期的会话仍有效。
- 桌面连接器使用 relay 签发的一次性设备凭证。注册表保存 `tokenHash`、`deviceId`、`machineId`、名称、配对时间和吊销时间；`machineId` 在连接器运行时计算，不从旧 `relay.json` 读取。
- 协议为 v2。v1 连接器以 4003 拒绝并提示升级；同一设备换机器、复制 `relay.json` 或使用旧 token 会被拒绝，第二个连接顶替第一个并让旧连接收到 4002。
- 登录失败按 IP+账号与账号两级限流；受信代理之外不采信 `X-Forwarded-For`，只从右向左找最右的非受信地址。`/connector`、未绑定 socket、WS 帧和 HTTP body 都有上限。
- 每个设备最多 4 条 live feed；慢消费者进入有界队列，超过 4 MiB 或 30 秒未 drain 就断开。手机取消会发 `cancel`，桌面用 `AbortController` 终止对应请求；旧 socket 的 close 不安排第二次重连。
- 手机端点默认拒绝。群聊、目标、记忆/学习、Bot/群设置和只读查询在允许列表中；`providers`、`provider-*`、`secret-*`、`capability-*`、`connector-*`、`relay-*`、`diagnostics*`、安装器和文件夹选择器继续拒绝。
- 自绘页返回 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy` 和 `X-Frame-Options: DENY`。哈希资源长缓存，入口页 `no-store`，文本资源 gzip，SSE 不压缩。Android release 禁止明文，debug 才允许本地明文。

### 群聊、记忆与学习

- 群聊采用官方 `groups/turns/parts/roster/delivery/goals`，用 `sessionOfRoom`/`roomOwners` 读取会话，不再有 `relaySessionOf`、`roomBySession`、`room-chat` 或 `roomPage`。
- 桌面与手机读取同一套群会话和 feed；手机发送进入当前群会话，不另建群聊读取路径。
- 新群会话保留群名、成员、设置和群记忆，归档旧会话并生成新的 `room.sessionId`。复制群复制成员与设置，但不复制会话和记忆。
- 记忆历史显示时间、来源与内容，可按单条记录恢复。恢复遇到内容已变化时返回冲突，不静默覆盖。
- 学习提议在空闲时触发并限频；用户批准后才落盘，拒绝后记住。提议与日志不含密钥。

### 数据迁移

- 新基线第一次读取旧 `state.json` 时，先同步复制为 `state.json.bak-<timestamp>`，再在内存里迁移。备份是同步的，保证 session 索引在第一个工具或 shell 环境调用前就存在。
- state 仍为版本 1；Bot、群、记忆、模型设置保留，无法识别的顶层字段原样保留。
- 被删除的 `relays`、`relayLimit` 写入 `state-migration.log`，格式为 `<ISO 时间> retired group <id>: <key>=<JSON 值>`。
- 备份或日志写入失败时，加载失败且不覆盖原 `state.json`。已有任意 `state.json.bak-*` 时不再重复备份。
- 升级后手机会话和桌面设备凭证各失效一次。电脑需要在 Settings → Remote control 重新登录，再重新配对手机；手机侧会提示这一点。

## 不做什么

- 不采用上游 `feat/mobile-link` 的 Expo 原生 App 和 Noise 配对。远程控制仍走本仓库的 relay + Web 壳。
- 不引入 IM、连接器、本地 Agent 或电脑操控。
- 不升级 DSH 到 0.2.2-rc.1，不 merge 官方 `dev`，也不把本地 `main` merge 进新分支。
- 不做 npm 发布，不自动晋级 `main`。
- 不为已退役的 `room-continue`、`relayLimit`、`room-chat` 提供兼容层。

## 已知限制

- 手机会话和桌面凭证的失效是预期的一次性破坏性变化，无法无损迁移旧 token；只能重新登录与配对。
- 旧 `state.json` 里的 `relays`/`relayLimit` 不恢复，只保留在备份和迁移日志里。
- 新群会话和复制群只改会话生命周期，不改变官方 turn、Goal 或成员权限流程。
- 发布前仍需完成桌面安装/升级/卸载与手机登录/发消息/群聊手工验证；未执行的平台构建不得写成通过。
- OpenSpec CLI 不在本机，规格自检以文档和测试命令代替 `openspec validate`。

## 回滚

1. 晋级前：`main` 仍在 `c6135ea`，停止使用 `sync/upstream-v0.2.7` 即可回退，不需要移动 `main`。
2. 晋级后：在用户确认下把 `main` 指回 `c6135ea`，并从旧提交重新构建发布包；不要改写已发布的新 tag。
3. 数据：关闭新版 DS Bot，保留当前 `state.json`，把 `state.json.bak-<timestamp>` 复制回 `state.json`。旧版会忽略新版多出的字段。
4. 手机壳：relay 保留最近两个 Web Shell；把配置切到上一个版本目录，或重新部署旧版 relay 包。
5. 远程控制：设备注册表与会话表可整表吊销；桌面重新登录会签发新设备凭证，手机旧会话不会被复用。

## 验证记录

2026-11-05 本轮功能自测（本机 macOS arm64）：

| 命令 | 结果 |
|---|---|
| `cd ds-bot && node --import ./test/harness-resolve.mjs --test "test/*.test.js"` | 1675 tests，1673 pass，2 skipped，0 fail |
| `cd ds-bot && node scripts/lint.mjs` | 通过（exit 0），40 warning，0 error |
| `cd ds-bot && node scripts/build-client.mjs --check` | 通过（exit 0） |
| `cd app && node --test "test/*.test.mjs"` | 436 tests，433 pass，3 skipped，0 fail |
| `node scripts/scan.mjs <git archive HEAD>` | `must fix: 0`；`can stay: 433` |
| workflow YAML 解析 | `test.yml`、`android.yml`、`release.yml` 均可被 `YAML.load_file` 解析 |
| 版本一致性 | `app`/`ds-bot`/`relay`/`web` 与 `web/manifest.json` 均为 `0.3.0` |

同一天的 GitHub Actions（提交 `c7321766` 起）：

| workflow / job | 结果 |
|---|---|
| Test · Desktop app profile | 通过（含 `app/test/release-notes.test.mjs`） |
| Test · Leak scan | 通过 |
| Test · Relay | 通过 |
| Test · Web shell | 通过（本机缺少 `web/node_modules`，以 CI 结果为准） |
| Test · Mobile app typecheck | 通过 |
| Test · ubuntu Node 22/24 与 windows Node 24（DSH rc.2/rc.5） | 通过 |
| Test · Desktop app package（macOS arm64/x64、Windows、Linux x64） | 通过：打包后启动页面，等待团队视图、模型卡片、问候、输入框与回复 |
| Android · Build APK | 通过：`assembleRelease`、release manifest 拒绝明文、上传 `DS-Bot-android` |

自测中发现并修正（本会话）：

- `client.js` 的注册 id 写死为 `ds-bot`，而包名是 `@lininn/ds-bot`；DSH 按包名查找，导致打包应用的团队视图不调用 `ready()`、桌面安装检查超时。改为从 `package.json` 读取包名，并让 bundle 测试断言该 id。
- 换基线时丢失的 fork 内容全部恢复：`ds-bot` CLI（`bin/`、`cli.test.js`、`package.json` 的 `bin` 与 `dsBot.verifiedDsh`）、根 README 与插件 README 的快速开始/命令行/远程控制/中文段落、架构图、桌面安装测试、relay 连接器与控制器测试。
- `app/test/release-notes.test.mjs` 仍按旧 tarball 名 `ds-bot-*.tgz` 断言，改为 `lininn-ds-bot-*.tgz` 和 fork 的 release 链接。
- `state-migration` 的清理钩子先删目录再停插件，CI 上出现 `ENOTEMPTY`；改为先 `await ctx.dispose()`，再恢复权限并删除。
- Android CI：SDK 仓库已移除 `tools` 包，且 `yes | sdkmanager` 在 `pipefail` 下因 broken pipe 失败；改为只请求 `platform-tools`，并直接安装 platform 34（licenses 由 setup-android 接受）。

本机 relay 实进程冒烟（`BLOG_API_URL` 指向不可达地址，`COOKIE_SECURE=0`，临时 `DSBOT_RELAY_DATA`）：

- `/` → `303` 到 `/login`，带 `Content-Security-Policy`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`X-Frame-Options: DENY`、`Cache-Control: no-store`。
- `/web-dist/0.3.0/` → `200`，入口页 `no-store`；哈希资源 `public, max-age=31536000, immutable`，带 `Accept-Encoding: gzip` 时返回 `content-encoding: gzip`。
- 路径穿越 `/web-dist/0.3.0/../../../../etc/passwd` → `404`。
- WebSocket `/connector`：v1 bind → close `4003 protocol mismatch; update the desktop app`；v2 无效凭证 → close `4001 bad device credential`。
- relay 与 ds-bot 的允许列表各 49 项且完全一致，`RELAY_PROTOCOL` 两侧均为 `2`。
- `web/dist` 与 `relay/web-dist/0.3.0` 内容一致（仅多出 `manifest.json`）。

换基线阶段发现并修正：

- 换基线时丢失的 `scripts/scan.mjs` 中 `PKG_NAME`，恢复为 `@lininn/ds-bot`，避免泄漏扫描误判包名。
- Android 构件名仍用旧产品名，统一改为 `DS-Bot-android`（workflow 与 README）。
- 将本地数据与生成物加入 `.gitignore`：`/web/dist/`、`/relay/web-dist/`、`/relay/data/`、`/app/.dshtest/`。

本机未能执行、改由 CI 覆盖（不把本机未跑写成通过）：

- `cd app && npm run dist`：本机 `beforePack` 下载 Office 运行时（GitHub Release 上的 Python 独立构建）两次都超时。CI 的四个 `Desktop app package` job 在 runner 上完成打包、启动检查；Windows 还走安装、升级与卸载，Linux 走 deb/AppImage 安装与更新。
- `cd android && gradle assembleRelease`：本机没有 `gradle` 与 `ANDROID_HOME`。CI Android workflow 完成 release APK、明文拒绝检查并上传 `DS-Bot-android`。
- `cd web && npm run build`：本机 `web/node_modules` 缺失；CI Web shell job 完成构建。
- Docker 启动与数据归属迁移：本机没有 docker；CI 的 `Docker startup and data migration` job 通过。

仍未执行（无设备/环境，不计为通过）：

- 真机手机登录、发消息、群聊、记忆与审批的手工验证。自动化覆盖白名单两端一致、请求转发测试与共享客户端构建，但没有真实手机。
- 用真实宿主 `state.json` 副本做一次启动演练。`state-migration` 测试覆盖备份、保留未知字段与退役设置日志，Docker job 覆盖数据归属迁移，二者都不是这一演练本身。

## 变更

- 2026-11-05：建立本记录、统一 0.3.0 版本并写下基线、迁移与回滚规则。
