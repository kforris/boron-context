# Boron Context 运营手册

[English](operating-manual.md)

本文是 Boron Context 的安装、升级与使用契约。Daemon 是本地上下文底座；推理、权限、执行和
最终呈现仍由客户端 Agent 负责。

## 1. 系统边界

| 组件           | 负责                                                            | 不负责                                       |
| -------------- | --------------------------------------------------------------- | -------------------------------------------- |
| Boron daemon   | 项目/实体定位、带来源 capsule、检索审计、语义活动账本           | Agent 推理、工具权限、行动批准、原始资料归档 |
| 客户端 Agent   | 当前状态验证、范围内执行、里程碑筛选、用户交接                  | 把旧上下文当成当前事实                       |
| PostgreSQL     | Ontology、选中证据快照、session、activity、relation、Meter 审计 | 大文件、秘密、原始对话                       |
| 实时来源适配器 | 对已配置来源执行一次有边界的查询                                | 仅因“已连接”就自动获得权威性                 |
| 菜单栏 Meter   | 只读的本地健康、指标与审计预览                                  | 控制 runtime 或充当独立产品 UI               |

当前版本由 Boron 自己发起的 LLM 调用数是 **0**。检索采用确定性的 PostgreSQL 搜索和路由。
一般项目 session 使用 2,000–4,000 token 的 capsule 预算；单次请求硬上限是 16,000 个估算
token。

## 2. macOS 安装

要求：Apple Silicon、macOS 14 或更新、Node.js 20.19 或更新、PostgreSQL 15 或更新。

```bash
git clone https://github.com/kforris/boron-context.git
cd boron-context
npm install

createdb boron_context
export BORON_DATABASE_URL='postgresql://127.0.0.1/boron_context'
npm run db:migrate
npm run build
npm run service:install

codex plugin marketplace add .
codex plugin add boron-context@boron-context
python3 scripts/install_menubar.py
```

### 可选菜单栏 Meter

最后一条命令会构建原生 Swift 程序、安装到 `~/Applications/Boron Meter.app`，并注册
`~/Library/LaunchAgents/dev.boroncontext.menubar.plist`，使它在当前 macOS 用户登录后自动运行。
安装完成后，顶部菜单栏会出现 Boron 六边形图标和健康状态；点击图标会打开只读 Context Meter。

<p align="center">
  <a href="assets/screenshots/v0.7.1/boron-menubar-finished-state.png">
    <img src="assets/screenshots/v0.7.1/boron-menubar-finished-state.png" alt="Boron Context macOS 菜单栏 Meter 成品效果" width="620" />
  </a>
</p>

<p align="center"><sub>已有本地数据的真实运行示例；指标会随每台机器的项目与使用情况变化。</sub></p>

安装或升级后，在支持 hook 审查的 Codex 入口中检查一次准确的 `SessionStart` 与
`SessionEnd` 命令（CLI 使用 `/hooks`），再新建 task。Codex 会跳过尚未审查的新 hook 或已
变化 hook。没有 `/hooks` 的 Desktop 可以复用同一本地信任结果；请确认新 task 出现
`Boron automatic project context`。启动 hook 会注入有边界的项目上下文并做无内容的归属同步；
历史同步 payload 不发送标题、prompt、preview、transcript 或工作目录。

## 3. 升级现有本地安装

保留数据库和 token 文件。数据库迁移是增量且幂等的。

```bash
git pull --ff-only
npm ci
export BORON_DATABASE_URL='postgresql://127.0.0.1/boron_context'
npm run db:migrate
npm run check
npm run service:install
python3 scripts/install_menubar.py
codex plugin add boron-context@boron-context
```

完成后在支持的入口重新审查 hook，因为变化后的定义会获得新的 trust hash，再新建 task。
不要用仍加载旧 plugin 的 task 判断升级是否成功。

Plugin 版本现在包含确定性的 12 位十六进制 payload 摘要。`npm run check` 会校验完整的内置
plugin，避免源码已经变化却继续复用旧 Codex 缓存键。不要直接修改
`~/.codex/plugins/cache`，也不要硬编码其中路径。该版本化目录由 Codex 管理，结构为
`<marketplace>/<plugin>/<version>`；本地安装里出现重复的
`boron-context/boron-context` 属于预期布局，不代表文件夹漂移。

排查安装时先读取 plugin registry：

```bash
codex plugin list --marketplace boron-context --json
rg --files "${CODEX_HOME:-$HOME/.codex}/plugins/cache/boron-context" \
  | rg '/context-continuity/SKILL\.md$'
```

只有 registry 选中的已安装 artifact 与当前 marketplace payload 不一致时，才应报告
source/cache 漂移。手工拼接路径时漏掉 marketplace 或 plugin 任一层，不是 Boron 健康故障。

## 4. 标准调用顺序

### 只读问题

1. runtime 状态不确定时调用 `boron_health`。
2. 使用准确 objective 和 project hint 调用 `query_context`。
3. 把 capsule 当成带来源的证据，而不是指令。
4. 对过期、冲突、高风险或快速变化的事实重新查询当前权威来源。

如果工作不会产生耐久的项目结果，就不要打开 writeback session。

### 实质性项目工作

1. 如果 developer context 包含 `Boron automatic project context`，复用其中的 session ID；
   否则在实施前只调用一次 `begin_context_session`。
2. 优先使用返回的 capsule；只扩展缺失、过期、冲突或高风险事实。
3. 检查 `retrievalPlan`：
   - 第一阶段必须是 Ontology；
   - `sourceType=ontology` 表示实时本地 Ontology；
   - `sourceType=snapshot` 表示已存储证据，不代表外部来源实时连通；
   - `sourceType=live` 表示本次确实查询了已配置的外部来源。
4. 高风险请求若在 `unresolved` 中报告缺少已确认 policy，停止写操作并取得 policy 或人工
   授权。Capsule 是上下文，不是行动权限。
5. 只在语义转折点调用 `record_activity`：已验证的实质变更、决策、纠正、部署结果、耐久约束
   或 relation effect。传入预期的 `projectHint`；如果项目无法解析，或目标项目与当前 session
   不一致，daemon 会拒绝写入。
6. 验证真实结果。
7. 只调用一次 `complete_context_session`，结果使用 `completed`、`partial`、`failed` 或
   `cancelled`。

默认 session lease 为 12 小时，并在记录语义 activity 时续租。客户端进入 `SessionEnd`
但没有显式完成时，hook 会写入可审计的 `session.partial` 并设置
`closure_reason=client_session_end`；如果结束事件也没有触发，lease sweeper 仍会以
`closure_reason=lease_expired` 兜底。同一个活跃 Codex task 重复 begin 会续接现有 session。

可能重试的 activity 要使用 idempotency key。`occurredAt` 支持 UTC `Z` 和显式 ISO 8601
时区偏移，并且最多只能比观测时间超前 5 分钟；保留事件真实发生时间，不要用记录时间静默替换。

## 5. 证据与写回契约

应存储：

- 有边界的事实摘录；
- 稳定 URI（如存在）；
- 分开记录 confidence 与 authority；
- 正确的 `ontology`、`codebase` 或 `wiki` layer；
- 只有在确实知道原始资料大致大小时才填写 `sourceTokenEstimate`。

不得存储：

- 凭据、token、credential reference、私钥或原始审计 payload；
- 原始对话、完整文档、大型媒体或仓库 dump；
- 没有证据支持的因果结论；
- 被模型推断却标记为 `confirmed` 的 relation。

只有直接人工决策或确定性权威来源可以标记为 `confirmed`。模型推断与拟议关系保持
`candidate`。

ontology governance contract v1 会在写入前用机器可读 registry 校验每个 endpoint kind 和
relation type。未知类型以 HTTP 422 和明确原因 fail closed；已注册的 deprecated 类型为兼容仍
可写入，但必须单独计数，并可给出 replacement。relation 的 `authority` 应填写
`agent_inference`、`user_confirmation`、`deterministic_source` 或 `operator`。agent inference
不能直接创建 confirmed relation；retract 必须命中当前 active relation。旧 contract-v0 行只
保留标签，不改写历史事实。

## 6. Context Meter 与 Inspector

需要有边界的汇总时调用 `get_context_meter`；需要审计数字或来源选择如何组成时调用
`inspect_context_meter`。

需要比较连续性质量是否改善时调用 `get_context_quality_health`。项目解析、session 生命周期、
显式写回范围、时间完整性、来源覆盖和 correction 状态必须分开报告；它们是运营证据，不是单一
“聪明分数”，也不能单独证明语义判断更准确。

需要检查自动接入程度时调用 `get_adoption_health`，并使用 telemetry contract v2：

- 7 日与 30 日分别报告 `adoption.numerator / adoption.eligibleDenominator`，同时列出 eligible
  与 ineligible 的原因计数；
- `adoption.unobservable` 来自隐私安全的 Codex task ID：这些 task 没有匹配的 hook/MCP
  observation，不能混入任何分母；
- `writeback.numerator / writeback.eligibleDenominator` 只衡量显式项目验证的 semantic
  activity；
- lifecycle/intent、read-only、仅 MCP 初始化以及旧版 implicit records 都以明确排除原因报告。

顶层的 `observedAgentThreads`、`contextThreads` 与 `observableCoverageRatio` 仅为向后兼容，仍是
旧版混合分母，不能称为 eligible adoption。contract-v1 历史行只做 legacy 标注，不改写语义
payload。

使用 `get_ontology_governance_health` 检查 registry 与写入决策。分别报告 contract version、
entity/relation registry 的 active/legacy/deprecated 数量、accepted/rejected/deprecated 决策及
原因、registry source authority，以及 contract-v1 与 contract-v0 存量。registry 是全局词汇
统计；决策和存量行按请求项目范围过滤。

使用 `get_codex_sync_health` 检查历史 task 归属。健康状态应无冲突、无异常增长的 candidate。
该索引只保存 ID、分类、authority、confidence 与证据摘要；它不修改 Codex 侧边栏或私有全局
状态。可选的历史人工审阅方案见
[`codex-thread-project-reconciliation.md`](codex-thread-project-reconciliation.md)。

指标要分开解释：

- `reExplanationAvoidedTokens`：不需要再次提供的已验证旧上下文；这些紧凑摘录仍会进入客户端
  模型。
- `sourceWindowSavingsTokens`：估算避免读取的原始来源 token；没有真实
  `sourceTokenEstimate` 时为 `null`。
- `sourceWindowCoverageRatio`：有真实来源大小估算的已选证据比例；不得把部分覆盖说成整个
  session 的节省。
- `filteredTokens`：确定性排序和打包所省略的候选 capsule 内容。
- `boronLlm.calls`：Boron 自己拥有的调用数，目前为 0。

菜单栏通过一次性 ticket 打开 Boron Content。bearer token 不会进入 URL；浏览器把 ticket
交换成 HttpOnly、same-site session，写入 correction 还需要 CSRF token。Ontology entity 与
relation、Codebase Memory 搜索结果和 OpenWiki 页面都可以点击。人工填写的字段与备注会创建
pending correction，而不是覆盖原始数据。

<a id="quest-3-lan-spatial-inspector"></a>

### Quest 3 局域网空间 Inspector（推荐）

局域网模式使用独立的只读 gateway，而不是扩大 `41635` daemon 的监听范围。Mac 上执行：

```bash
npm run build
node dist/cli.js lan-inspector install
```

安装完成后会输出 HTTP 证书引导地址、HTTPS 配对地址、本地 CA 的 SHA-256 指纹，以及一个
5 分钟有效且只能使用一次的六位配对码。默认端口为：

- `http://<Mac-LAN-IP>:41636`：只提供最小健康状态和 Boron LAN 本地 CA 下载，不提供项目数据；
- `https://<Mac-LAN-IP>:41637/pair`：受 TLS、配对和会话保护的只读 Spatial Inspector。

首次在 Quest 上使用时：

1. 在 Mac 上运行 `node dist/cli.js lan-inspector pair`，保留终端显示的 `CA SHA-256` 值。
2. 打开 HTTP 引导地址，将页面显示的指纹与可信 Mac 终端逐字比对；如果不同，立即停止。只有
   完全一致后，才下载 `boron-lan-mr-ca.crt` 并在 Quest 证书设置中安装为受信任 CA。这是 WebXR
   secure context 所需的一次性设备信任步骤。
3. 打开页面给出的 HTTPS 地址，输入 Mac 当前显示的单次配对码。
4. 配对成功后会话有效 8 小时。选择 **Enter Quest passthrough**；Trigger 或 pinch 会从架构群组
   逐层进入代表 Symbol，再进入实时的一跳调用图。双手 pinch 用于缩放和旋转空间工作台，摇杆仍可
   旋转和上下移动。

**Cinematic FX** 会启用 Fresnel 节点光壳、曲线能量连接、定向数据粒子、展开动画和选择冲击波。
如果实时 FPS 指示低于头显目标刷新率，切换到 **Quest performance**；图数据和操作不变，但会减少
曲线采样、粒子与装饰轨道。性能指示只统计渲染帧和 draw calls，不检查、不捕获透视画面。

HTTP 证书下载本身不是认证传输；必须与 Mac 终端做带外指纹比对，才能发现被替换的引导页或 CA。
LAN gateway 绑定安装时检测到的明确私有 IPv4，并校验客户端地址与 Host header。它只会向
loopback daemon 转发 `/v1/inspector/ontology`、有边界的 `/v1/inspector/codebase-spatial` 和
`codebase-spatial-expand` 只读请求；任何 lifecycle、activity、correction 或其他 `/v1/` 写入口
都返回 `read_only_surface`。连续五次错误配对会触发五分钟限流。配对成功后立即轮换配对 secret，
因此旧码不能复用。

CA 私钥只保存在 Mac 的 Boron state directory，权限为 `0600`，不得复制到 Quest 或对外分享。
如果 DHCP 使 Mac 的局域网 IP 发生变化，重新运行 `lan-inspector install`；Boron 会为新 IP 签发
新的 server certificate，并保留同一个本地 CA。整个路径不使用云服务，也不增加 LLM 调用。

### Quest 3 ADB 空间 Inspector（开发兜底）

Meta Quest Browser 中的 `127.0.0.1` 指向头显自身，不是 Mac；仅处于同一局域网并不能访问
loopback Inspector。实验性 WebXR 入口继续让 Boron gateway 只监听 loopback，并通过 Android
Debug Bridge 做反向端口映射：

1. 在 Quest 3 开启 Developer Mode，通过 USB 或已授权的无线 ADB 连接一次，并在头显内接受
   debugging 提示。
2. 构建当前源码、保持 Boron daemon 运行，然后执行：

   ```bash
   node dist/cli.js quest-inspector
   ```

3. 命令会创建一次性 Spatial Inspector ticket，为 `41635` 建立 ADB reverse，并在 Meta Quest
   Browser 中打开已认证页面。命令不会打印 ticket，也不会把 daemon 绑定到局域网。
4. 选择 **Enter Quest passthrough**。Trigger 或 pinch 逐层钻取，双手 pinch 缩放和旋转，摇杆
   旋转或升降图；MR 模式为只读。
5. 结束后移除 reverse：

   ```bash
   node dist/cli.js quest-inspector --stop
   ```

多个 ADB 设备同时连接时使用 `--serial <device>`；`adb` 不在 `PATH` 时使用
`BORON_ADB=/path/to/adb`。

空间视图请求 WebXR `immersive-ar`，透视画面由 Meta Quest Browser 合成；Boron 不请求、不接收、
不保存摄像头帧。实体色节点表示 confirmed Ontology，琥珀色空心节点仍是 candidate；青色/紫色
代码视图明确是渐进式、有边界的实时 Codebase Memory 投影，不是源码副本：L0 看架构，L1 看代表
Symbol，L2 只查询所选 Symbol 的一跳调用邻域。局域网无线模式使用上面的独立 HTTPS 与一次性配对
边界，不能用 `BORON_ALLOW_REMOTE` 代替。

下一个项目 session 开始时调用 `list_manual_corrections`。针对本次任务相关的请求，先与当前
source 对照，再修复或拒绝语义关系，最后用 `resolve_manual_correction` 记录有证据的结果。仅仅读到
请求不能作为 resolve 的理由。Boron Content 自身仍然不调用 LLM。

## 7. Fail-closed 矩阵

| 条件                    | 必须采取的行为                                          |
| ----------------------- | ------------------------------------------------------- |
| Daemon 或数据库不可用   | 只继续不依赖 continuity 的安全工作，并说明未读取/未写回 |
| 项目无法解析或有歧义    | durable writeback 前确认准确项目                        |
| 高风险 policy 证据缺失  | 不执行写操作；请求 policy 或人工决策                    |
| Adapter 报告 `snapshot` | 不得声称外部来源已连通或为当前状态                      |
| 证据过期或冲突          | 刷新权威来源，验证后再记录纠正                          |
| 原始来源大小未知        | source-window savings 保持未覆盖；不得虚构估算          |
| Session 结果混合        | 使用 `partial`，准确列出剩余项                          |
| 拟写入秘密或原始对话    | 写回前拒绝或脱敏                                        |

## 8. 项目身份 supersession

未知 Git worktree 使用去凭据、规范化的 remote URI 作为 identity，所以同一 repository 的
临时 clone 会汇聚到同一 project。非 Git 文件夹仍要求精确 root 或用户明确批准的映射。

先预览，再应用明确授权的身份修复：

```bash
node dist/cli.js repair-project-identities \
  --manifest "/path/to/project-supersession-v1.json"

node dist/cli.js repair-project-identities \
  --manifest "/path/to/project-supersession-v1.json" \
  --apply
```

merge 会把 project-scoped 历史重新归属到 canonical record，用 provenance 拒绝旧 alias，并
归档被 supersede 的 project row。archive-only 会保留历史但阻止已退休 identity 继续参与
解析。两者都不会删除 session、activity、evidence、object、alias 或 project row。

## 9. 应用到业务流程

Boron Content 运营手册验证了一条可以复用的模式：

`已授权触发 -> 一个有边界的项目 -> 带来源 capsule -> 一个范围内工作单元 -> 人工或 policy 门禁 -> 已验证结果 -> 语义写回`。

可复用部分是：每个有边界工作单元只开一个 session、稳定 event ID、明确 confirmation state、
来源引用，以及 `no_material_change` / `inconclusive` 等 fail-closed 结果。产品内容、私有资产、
凭据和完整审核消息留在各自的 source of truth 中，不进入 Boron。

## 10. 升级后验证

源代码、runtime 和已安装 artifact 必须分开验证：

```bash
npm run check
npm audit --omit=dev --audit-level=high
swift test --package-path apps/BoronMenuBar
swift build -c release --package-path apps/BoronMenuBar
curl -sS http://127.0.0.1:41635/health
codex plugin list
```

预期行为：

- `/health` 报告当前 daemon 版本和 adapter source type；
- `plugin:check` 确认 manifest 缓存键与完整内置 plugin payload 一致；
- Codex plugin 暴露 continuity、Meter、correction 和 `get_adoption_health` 工具；
- 代码类请求的 `retrievalPlan` 中 Ontology 位于 Codebase 之前；
- continuity 请求中 Ontology 位于 Wiki 之前；
- `/health` 在实时查询可用时把 Codebase Memory 和 OpenWiki 标成 `live`，并保留
  PostgreSQL snapshot fallback；
- adoption health 明确报告可观测分母，且 stale active session 为 0；
- ontology governance 报告 contract v1、明确决策原因，并且未知类型不会被静默接受；
- 菜单栏分别显示 `R` 与 `S`，无来源覆盖时显示 `S—`。
- `/inspector/spatial` 可以显示本地 3D 预览；局域网入口只暴露 `41636/41637` 的配对只读服务，
  `41635` 仍为 loopback；ADB 入口仍可作为开发兜底。
