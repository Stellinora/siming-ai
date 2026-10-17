# 项目重点路径审查 — 2026-10-13

> 后续修复已落入工作区。下文保留审查时的证据；当前实现和验证边界见 [修复记录](./2026-10-13-project-review-fixes.md)。

## 范围与结论

审查对象是当前 `main` 工作区，包含尚未提交的 API 请求策略与默认 128K 上下文改动。重点覆盖 PC 写作/大纲编辑、手机独立 Agent 的资料写入、建档状态机、模型请求与发布门禁。

确认 **4 项 P1、7 项 P2**。P1 涉及错章写入、未保存内容丢失或成功回执与真实数据不符，应优先修复；P2 涉及请求可靠性、任务边界和发布检查。

本轮没有修改业务实现，没有调用真实付费模型或写入用户小说。验证使用模拟 HTTP、模拟前端 API、SQLite 内存库及针对性测试；没有重新进行手机真机全流程测试。临时复现文件放在 `.build/audit-20261012`（审查开始时的日期）。这些复现测试的“通过”表示成功触发了缺陷，不表示缺陷已修复。

## P1：优先修复

### F01. 恢复历史版本的迟到响应可能导致错章保存

- 位置：[WriterPageContent.tsx:1036](../../frontend/src/features/writer/WriterPageContent.tsx#L1036)，保存目标：[同文件:868](../../frontend/src/features/writer/WriterPageContent.tsx#L868)。
- 触发：在 A 章恢复历史版本，响应尚未返回时切换到 B；A 的响应到达后，无条件覆盖当前 `detail` 和正文表单。
- 影响：界面当前选择仍是 B，但内容和版本来自 A。继续编辑后保存，请求会发到 `/chapters/B`。当两章版本号相同，乐观锁不能识别实体混用。
- 证据：隔离前端测试设置 A 恢复后为 v2、B 为 v2，确认 A 的历史正文进入 B 编辑器，随后 PUT 的目标确实为 B。
- 建议：恢复操作绑定项目、章节、请求序号和编辑版本；返回时只更新仍由该请求拥有的编辑会话。保存前额外校验 `detail.id === selectedId`。切章和新 AI 草稿都必须令旧响应失效。

### F02. 后台刷新会覆盖未保存的正文和大纲编辑

- 位置：[WriterPageContent.tsx:392](../../frontend/src/features/writer/WriterPageContent.tsx#L392)、[刷新入口:708](../../frontend/src/features/writer/WriterPageContent.tsx#L708)、[OutlinePage.tsx:387](../../frontend/src/pages/OutlinePage.tsx#L387)。
- 自动触发来源：[CatalogingRefreshBridge.tsx:23](../../frontend/src/features/cataloging/CatalogingRefreshBridge.tsx#L23)。后台建档进度/终态变化会发出全局刷新信号。
- 影响：刷新重新读取正式章节并无条件回填表单、调用 `markSaved()`。作者未保存的修改消失，界面反而显示“已保存”。正式大纲节点也在列表刷新后无条件回填。
- 证据：正文修改为“作者未保存的重要修改”，触发全局刷新后恢复为数据库旧正文，且没有发生 PUT；正式卷纲的未保存标题也被清除。
- 建议：把只读状态刷新和可编辑正文载入分开；表单脏或请求发起后发生编辑时，不得回填正文、清除修订候选或清脏。保存成功也应只清除对应编辑版本的脏状态。

### F03. 建档候选可被直接标成 applied，造成假完成

- 位置：[工具处理器:257](../../backend/app/services/workspace/tools/cataloging.py#L257)、[工具契约:113](../../backend/app/modules/continuity/interfaces/tool_definitions.py#L113)、[REST 更新模型:40](../../backend/app/schemas/cataloging.py#L40)、[批量更新模型:55](../../backend/app/schemas/cataloging.py#L55)。
- 触发：对尚未实际写入的摘要候选提交 `status="applied"`，然后执行正常确认。候选应用器会跳过已标记 applied 的记录。
- 证据：隔离内存库返回 `job=completed`、`run=completed`、`cataloging_required=false`，但正式 `ChapterSummary` 行数为 **0**。工具入口还允许修改已 applied 候选并将其改回 pending。
- 影响：任务中心显示建档完成，后续写作却缺少正式摘要；已写入候选的审计记录也可与实际业务数据脱节。
- 建议：`applying/applied` 只能由事务执行器写入。作者/模型可编辑状态使用独立枚举；REST、CLI、MCP 使用同一更新服务并禁止改写已应用候选。完成判定还应验证正式写入结果和应用记录。

### F04. 手机助手部分工具字段未保存，却返回成功

- 位置：[MobileWorkspaceAgent.kt:2190](../../mobile/android/app/src/main/java/com/siming/mobile/data/agent/MobileWorkspaceAgent.kt#L2190)、[大纲更新:2224](../../mobile/android/app/src/main/java/com/siming/mobile/data/agent/MobileWorkspaceAgent.kt#L2224)、[LocalAuthoringStore.kt:35](../../mobile/android/app/src/main/java/com/siming/mobile/data/authoring/LocalAuthoringStore.kt#L35)、[PcApiPayloads.kt:114](../../mobile/android/app/src/main/java/com/siming/mobile/data/network/PcApiPayloads.kt#L114)。
- 触发：模型按现有工具契约传入大纲 `character_names`，或新角色 `speech_style`、`ai_config`。
- 原因：工具参数直接当成资料对象交给写入白名单，没有执行 PC 工具处理器中的关联替换、风格转换和角色 AI 配置写入。过滤后的 mutation 才进入本地正式存储。
- 证据：参数边界测试确认这些字段被过滤；代码链路显示成功回执却来自过滤前的 payload。PC [大纲处理器:55](../../backend/app/services/workspace/tools/outline.py#L55) 和 [角色处理器:35](../../backend/app/services/workspace/tools/characters.py#L35) 有对应业务处理。
- 建议：为业务工具提供一致的参数到正式数据的转换；关联写入使用模型返回的真实实体 ID 并验证归属。成功回执读取实际保存结果。增加相同工具输入在 PC/手机上产生相同业务记录的对照测试。

## P2：调用稳定性、任务边界与发布检查

### F05. SDK 与网关重试叠加，放大 API 请求次数

- 位置：[OpenAI 客户端工厂:38](../../backend/app/ai/openai_adapter.py#L38)、[网关重试:411](../../backend/app/modules/model_runtime/infrastructure/gateway.py#L411)。
- 原因：`AsyncOpenAI` 保留 SDK 默认的 2 次重试，网关外层又按自己的 retry 计数重新调用。
- 证据：模拟接口持续返回 503，网关 `retry=0` 实际发出 **3 次 HTTP 请求**；默认 `retry=3` 实际发出 **12 次**。
- 影响：服务不稳定、限流或超时时等待会被放大，外层“不重试”无法兑现。章节生成使用 retry=1，同类错误也会放大为最多 6 次 HTTP 尝试。
- 建议：SDK 设置 `max_retries=0`，由统一网关管理重试次数、退避、Retry-After 和总时限；使用真实 SDK + MockTransport 统计请求数，避免仅用 FakeAdapter 验证外层次数。

### F06. 持续思考的纯文本流仍可能被当作空闲超时

- 位置：[OpenAIAdapter.stream_chat_completion:616](../../backend/app/ai/openai_adapter.py#L616)、[网关等待下一个事件:470](../../backend/app/modules/model_runtime/infrastructure/gateway.py#L470)。
- 原因：纯文本适配器只向外 yield 正文，思考帧被忽略。网关计时的是下一段正文，而不是传输是否仍有活动。
- 证据：模型每 25ms 返回一帧思考内容，超时设置 120ms。纯文本路径在收到 4 帧后报超时；同样序列走工具事件流可完成 10 帧并返回正文。
- 影响：显式开启思考或默认思考的第三方 API，长思考阶段可能被中断、重新请求。实际时限随调用方而异，通用默认为 120 秒，立项流为 300 秒。
- 建议：统一传输活动事件与正文展示事件；思考帧应刷新空闲计时，但不必展示为正文。不能靠对所有 API 关闭思考掩盖此问题。

### F07. 非流式调用忽略输出截断/未完成状态

- PC 位置：[OpenAIAdapter.chat_completion:552](../../backend/app/ai/openai_adapter.py#L552)、[Responses 非流式解析:388](../../backend/app/ai/openai_adapter.py#L388)。手机位置：[Chat 解析:825](../../mobile/android/app/src/main/java/com/siming/mobile/data/network/DirectApi.kt#L825)、[Responses 解析:863](../../mobile/android/app/src/main/java/com/siming/mobile/data/network/DirectApi.kt#L863)。
- 触发：HTTP 200，但 Chat 的 `finish_reason="length"` 或 Responses 的 `status="incomplete"`。
- 证据：PC 返回截断正文且丢失结束原因；手机对两种协议都将未完成响应中的合法 JSON 工具参数解析为正常可执行调用。流式路径已有完成检查，非流式路径没有。
- 影响：章节生成可能把截断内容作为成功草稿；手机资料生成也可能把未完成结果带入确认流程。结构合法并不能证明模型完成了本次输出。
- 建议：共享完成状态判定，在返回业务层前区分正常结束、长度上限、过滤、失败和中断；保留诊断信息，不把未完成工具事务作为成功结果交付。

### F08. 无效章节 ID 可能变成整书建档

- 位置：[ordered_chapters:18](../../backend/app/services/cataloging/context.py#L18)、[launcher:449](../../backend/app/services/cataloging/launcher.py#L449)。
- 原因：不存在或异作品 ID 被静默过滤。全部无效时得到空列表，创建任务时又把空列表解释为“全部章节”。
- 证据：请求 `['missing-or-foreign-chapter-id']`，返回 `requested_chapter_ids=[]`，但实际任务包含当前作品章节 `['c']`。
- 影响：过期界面或错误工具参数可能触发原本未选择的章节建档，增加模型消耗并更新已有档案。
- 建议：显式选择必须逐个校验 ID 和归属；区分未指定范围、明确空选择、校验失败，禁止空集扩大为全选。

### F09. 已取消任务可被迟到的恢复/跳过请求重新激活

- 位置：[skip-current 路由:332](../../backend/app/routers/cataloging.py#L332)、[mark_run_skipped:443](../../backend/app/services/cataloging/job_control.py#L443)、[recover 服务:193](../../backend/app/services/cataloging/manual_ops.py#L193)。
- 证据：取消包含失败章节的任务后，经实际路由函数调用 skip-current，状态从 cancelled 变成 running；recover-current 则变成 waiting_confirmation，且都保留原 completed_at。
- 影响：迟到/重复控制请求可让用户已取消的任务重新出现，状态和完成时间互相矛盾。
- 建议：在共享状态转换处统一验证允许的前置状态，采用状态/版本条件更新；若产品允许重新开启终态任务，应定义单独明确的操作并完整更新状态字段。

### F10. 拆书仍按模型名称注入 DeepSeek 私有思考参数

- 位置：[map_reduce.py:61](../../backend/app/services/deconstruct/map_reduce.py#L61)，同文件 105、172 行也有相同分支。
- 原因：只要模型字符串包含 deepseek，就写入 `thinking: {type: disabled}`。这绕过了当前按实际 endpoint/protocol 选择参数的统一策略；策略层会把它当成显式参数保留。
- 证据：模拟拆书 JSON 修复，模型名 `custom:deepseek-r1`、实际端点为硅基流动时，最终请求仍包含 DeepSeek 风格 `thinking` 字段。
- 影响：第三方托管同名模型时可能收到不适用的参数；并且同一个 API 在普通生成和拆书时行为不同。此项未对真实服务商发请求，不断言所有服务商都会拒绝该字段。
- 建议：删除拆书中三个名称判断，让调用方只声明任务类型，具体参数继续由统一 endpoint/protocol 策略决定。

### F11. 当前工作区尚未通过完整发布门禁

实际检查结果：

1. `scripts/check-architecture.py` 失败：[gateway.py:774](../../backend/app/modules/model_runtime/infrastructure/gateway.py#L774) 的 `stream_chat_completion_with_tools` 为 **156 行**，超过 150 行硬限制。
2. `scripts/check-mobile-pc-parity.py --check-doc docs/mobile-pc-parity.md` 失败：[契约:220](../../contracts/mobile-pc-parity.json#L220) 仍引用已改名的测试 `deepseek standalone conversation preserves thinking and omits unsupported tool choice`。

这两项包含上一轮未提交修改带来的检查遗漏。安装包编译成功不能证明发布门禁通过，当前状态直接进入相关 CI 会失败。

建议：按职责提取模型响应完成/恢复逻辑，更新跨端契约引用及行为验证。把架构、跨端契约和生成文件检查纳入本地打包前的统一预检，避免本机可打包、CI 不能发布。

## 验证汇总

| 检查 | 结果 |
| --- | --- |
| 模型请求策略、流式恢复、思考协议既有测试 | 98 passed |
| 建档计划、进度、MCP 权限既有测试 | 69 passed |
| 前端新增隔离缺陷复现 | 3/3，确认两个缺陷类别 |
| Android 参数投影/未完成响应复现 | 3/3 |
| 离线模型探针 | 请求次数、思考活动超时、非流式截断、拆书参数注入均复现 |
| 内存数据库建档探针 | 假完成、改已写入候选、取消任务恢复、无效范围扩大均复现 |
| 工具注册表 | 182 项元数据检查通过 |
| 前端架构边界 | 通过，279 模块无依赖违规 |
| OpenAPI 生成类型 | 与代码一致 |
| 手机上下文策略与 Prompt 契约生成检查 | 通过 |
| 模型网关/流式恢复/请求策略局部 Ruff 检查 | 通过 |
| 后端架构 / 跨端契约 | 上述两项失败 |

后端架构扫描未发现循环导入、路由直接 ORM 查询或直接提交事务。自动数据库备份已实现只保留最新已验证自动备份，本次没有确认该部分存在缺陷。

原始复现与日志仅保存在本机忽略目录，未随发布提交：

- 前端复现测试：`.build/audit-20261012/writer-state.test.tsx`、日志：`.build/audit-20261012/writer-audit-test.log`
- 手机复现测试：`.build/audit-20261012/mobile/MobileParityAuditTest.kt`、日志：`.build/audit-20261012/mobile-parity-tests.log`
- 建档内存库探针：`.build/audit-20261012/audit_cataloging_boundaries.py`、结果：`.build/audit-20261012/cataloging-probes.log`
- 模型离线探针：`.build/audit-20261012/probe_runtime.py`、结果：`.build/audit-20261012/runtime-probes.log`

## 建议实施顺序

1. 先修 F01–F04，保护作者编辑与真实保存结果；将当前缺陷复现改成永久回归测试，断言正确行为。
2. 统一模型请求的重试、传输活动和完成状态判定，处理 F05–F07 与 F10；使用 MockTransport/MockWebServer 验证实际 HTTP 请求和协议状态。
3. 收紧建档目标与终态转换，处理 F08–F09；共享业务边界供 REST、CLI、MCP 和手机调用。
4. 补齐 F11 发布检查；跨端验收同时核对工具输入、正式业务记录及成功回执，随后再做 PC/手机真实流程测试。
