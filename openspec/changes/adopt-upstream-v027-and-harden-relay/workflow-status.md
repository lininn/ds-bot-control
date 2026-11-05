# Workflow Status: adopt-upstream-v027-and-harden-relay

## Summary

- Phase: build
- Capture Mode: none
- Status: in_progress
- Last Updated: 2026-11-05
- Next Command: /openflow close
- Next Action: Publish v0.3.0 from the c7321766 release build, then record the real-phone drill (6.2/6.3) before close.

## Gates

| Gate | Status | Evidence |
|------|--------|----------|
| Requirements captured | passed | proposal.md |
| Specs validated | passed | specs/*, tasks.md（自检；openspec CLI 不可用） |
| Plan ready | passed | plan-ready.md |
| Implementation complete | passed | commit c7321766; ds-bot 1673/1675, app 433/436, relay 42/42 (CI), web build (CI), mobile typecheck (CI) |
| Verification complete | in_progress | local matrix + CI Test (16/16) + Android green on c7321766; real-phone drill not run (6.2, 6.3) |
| Archived | pending | - |

## Tasks

| ID | Task | Status | Verification | Blocked By | Notes |
|----|------|--------|--------------|------------|-------|
| 0.1 | 安装依赖、补齐 lockfile、记录基线 | verified | `npm run harness && npm test`; `cd web && npm install --package-lock-only` | - | web 无 lockfile |
| 1.1 | 建立新基线分支并记录回滚点 | verified | `git merge-base main sync/upstream-v0.2.7` 为空 | 0.1 | - |
| 1.2 | 移植 fork 独有层（只取 fork 文件） | verified | `git diff --stat 71d344bf -- ...`; 包名 | 1.1 | 不整文件覆盖 app |
| 1.3 | 按策略重放本地提交 | verified | patch-id/内容比对；`git log` | 1.2 | 跳过 merge/发布/生成物 |
| 1.4 | 恢复 relay 集成点 | verified | `rg "rt\\.handle|relay-status|subscribeFeed"` | 1.3 | feed 需补钩子 |
| 1.5 | 重新生成 client bundle 并让 ds-bot 通过 | verified | `cd ds-bot && npm test && npm run lint` | 1.4 | 路径在 ds-bot 下 |
| 1.6 | 适配桌面 app 启动架构 | verified | 本机 `app` 436/433；CI 四个 `Desktop app package` 全部通过启动检查 | 1.5 | 本机 `dist` 下载运行时超时，由 CI 覆盖 |
| 1.7 | 适配 Web Shell 与 Android | verified | CI `Web shell`；CI `Android · Build APK` | 1.5 | 本机缺 web/node_modules 与 gradle，由 CI 覆盖 |
| 1.8 | state 迁移备份与退役提示 | verified | `npm test -- --test-name-pattern="migrat|state"` | 1.5 | 含重新登录/配对提示 |
| 2.1 | 会话表、持久化与安全 cookie | verified | `npm test -- --test-name-pattern="session|logout|expire|restart|revoke"` | 1.7 | cookie 无 token |
| 2.2 | 设备凭证、协议 v2 与注册表 | verified | `npm test -- --test-name-pattern="device|revoke|duplicate|protocol|machine"` | 2.1 | v1 返回 4003 |
| 2.3 | 限流、真实 IP、Origin 与连接上限 | verified | `npm test -- --test-name-pattern="limit|forwarded|frame|origin"` | 2.1 | XFF 右向左 |
| 2.4 | SSE 背压、cancel 与重连风暴 | verified | `npm test -- --test-name-pattern="sse|slow|cancel|reconnect"` | 2.1, 2.2 | 每设备 4 个 |
| 2.5 | 安全头、缓存与版本清理 | verified | `npm test -- --test-name-pattern="header|cache|static|gzip|prune"` | 1.7 | prune 需接入发布 |
| 2.6 | Android 明文与 WebView 安全 | verified | CI `Android · Build APK`：`assembleRelease` + release manifest 拒绝明文 | 1.7 | - |
| 3.1 | cancel 帧与 AbortSignal 端到端 | verified | `npm test -- --test-name-pattern="cancel|relay"` | 2.4 | - |
| 3.2 | 连接器重连去重 | verified | `npm test -- --test-name-pattern="reconnect|relay"` | 2.4 | - |
| 3.3 | 手机端点默认拒绝白名单 | verified | `npm test -- --test-name-pattern="allow|forbid|endpoint"` | 1.4 | 完整列表见 tasks.md |
| 4.1 | 采用官方群聊引擎 | verified | `npm test -- --test-name-pattern="group|turn|delivery|goal"` | 1.5 | 缺失模块按新增 |
| 4.2 | 群聊在桌面与手机可见 | pending | `cd web && npm run build` + 手工 | 4.1 | - |
| 4.3 | 新群会话与复制群增量 | verified | `npm test -- --test-name-pattern="conversation|duplicate"` | 4.1 | - |
| 4.4 | 官方记忆历史/恢复与学习提议 | verified | `npm test -- --test-name-pattern="memory|learning|privacy"` | 4.1 | 脱敏用 secrets.js |
| 4.5 | 手机侧记忆/学习入口 | verified | relay/ds-bot 白名单均含 `memory-history`/`memory-restore`/`learning-answer`，parity 测试通过 | 3.3, 4.4 | 无真机，仅协议级验证 |
| 5.1 | CI 四包、结果门禁与安全扫描 | verified | YAML 解析 + `needs:` 检查 | 0.1, 1.6, 1.7 | 加入 result gate |
| 5.2 | 设计文档与 CHANGELOG | verified | 人工检查任务 ID | - | - |
| 5.3 | 版本 0.3.0、manifest 与 web-dist | verified | 四包版本 + manifest + `ls relay/web-dist` | 1.7 | sync-web.mjs |
| 5.4 | 行为命名测试与拒绝路径补齐 | verified | 三包 `npm test` | 2.x–4.x | 含 v1→v2 |
| 6.1 | 完整测试矩阵 | verified | 六条验证命令 | 全部 | ds-bot 先 harness |
| 6.2 | 迁移演练 | pending | 备份存在、计数一致、重新登录提示 | 1.8 | - |
| 6.3 | 桌面与手机手工验证 | pending | 手工记录/截图 | 6.1 | 含 4003/复制 relay.json |
| 6.4 | 发布证据与回滚说明 | verified | 文档完整 | 6.2, 6.3 | - |
| 6.5 | 晋级 main（需用户确认） | verified | `git log --oneline -1 main`; 回滚点可访问 | 6.1–6.4 | 唯一改写 main 的操作 |

## Amendments

| Date | Reason | Affected Specs | Affected Tasks | Status |
|------|--------|----------------|----------------|--------|
| 2026-11-05 | 独立 review 发现 lockfile、CI gate、协议兼容、XFF、SSE、晋级等问题，已回填 | relay-security, upstream-baseline, engineering-practices, group-engine | 0.1, 1.2–1.8, 2.1–2.5, 3.3, 5.1–5.3, 6.5 | applied |
