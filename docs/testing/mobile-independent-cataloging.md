# 手机独立章节建档回归

手机通过独立建档运行时完成“保存并建档”，保存 Gateway 地址不会改变执行位置。草稿生成先结束模型回合，由作者决定保存、建档和何时继续下一章。本文记录 3.4.4 的模型超时修复；后续资料操作、历史恢复及同步变化见 [手机独立操作验收](mobile-independent-authoring.md)。

## 模型请求与超时

3.4.3 的手机建档与立项对话都使用原生工具流式请求，但建档沿用了普通请求的 120 秒读取超时和 150 秒整次请求时限；持续输出超过 150 秒也会被截断。PC 建档按等待下一条有效流事件计时，连续 300 秒没有有效事件才超时，且 DeepSeek 建档明确关闭深度思考，手机此前缺少这项参数。截图中的 `timeout` 与这些差异相符，但仅凭截图无法确认服务端耗时或当时的思考模式。

当前建档任务参数由 PC 常量导出到 `cataloging.model_request`，Android 直接消费该契约。接口参数另由统一的 [模型请求策略](../model-request-policy.md) 按实际地址和协议处理：

- `stream_idle_timeout_seconds` 为 300 秒，表示等待第一条或下一条有效流事件的时限；正文、思考和有效工具参数会重新计时，持续输出允许超过 5 分钟。手机建档移除整次请求上限，由独立的事件计时器中断阻塞网络读取；注释心跳、空数据帧和只有角色标记的帧不会重置计时，本地进度回调耗时也不算模型等待时间。
- 温度为 0.1；输出上限为 20,000 tokens，手机同时遵守作者配置的较小输出预留。
- 官方 DeepSeek 地址的建档请求在 Chat Completions 中默认发送 `thinking.type=disabled`，在 Responses 中发送 `reasoning.effort=none`；硅基流动 Chat Completions 建档默认发送 `enable_thinking=false`。显式思考参数优先，第三方中转不因名称或模型包含 DeepSeek 而应用官方策略。参数含义见 [DeepSeek 官方思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/) 和 [硅基流动接口文档](https://docs.siliconflow.cn/docs/api/chat-completions-post)。
- 进度根据真实流事件显示等待响应、分析资料、返回内容或接收工具参数，不再始终显示“核对建档计划”。
- 建档等待超时明确显示连续多久未收到有效输出，有限重试用尽后将错误保存到任务。原生流的文字和工具调用只在完整响应校验通过后交付；断流和临时服务端错误按原请求重试，输出长度截断、拒绝、明确失败/未完成事件及无效工具参数直接失败。Responses 收到完成事件即停止等待。
- 取消直接终止正在等待数据的 HTTP 调用。失败保留正文和已接受候选；作者明确重试后复用前提未变化的计划，完成章节不重复建档。

3.4.4 的超时修复主要位于 Android。当前 PC/Gateway 和手机的接口默认参数均来自 `backend/app/ai/request_policy.py`，手机构建时生成对应契约，独立请求不依赖 PC 正在运行。

2026-10-15 起，手机独立模式与 PC 采用相同的原生工具响应恢复原则：临时断流时丢弃本次未完成的文字和工具参数，使用原始消息与工具定义重新请求，不拼接部分文字，也不要求模型返回正文续写检查点标记。手机共享 `streamAgentTurn` 使用既有 `retryDelaysMillis`，默认最多重试 3 次，等待依次为 700、1,500、3,000 毫秒；关闭 HTTP 客户端的额外连接重试。建档、立项和作品助手均经过此路径。模型思考与有效活动仍可显示进度；取消立即中断读取或重试等待，认证/请求参数错误、明确长度截断、拒绝及无效工具结构不会自动重试。重试用尽后仍由作者决定是否从本机持久化计划再次执行。PC 与手机的重试次数配置并未统一；两端自动化验证相同的响应完成与落盘边界。

此次恢复回归使用 Android JVM 与 MockWebServer，覆盖 Chat Completions/Responses 的半段文字加半份工具参数后断流、按原请求重试成功、重试耗尽、失败响应不发布部分文字、保留有效响应的思考及 provider state、明确失败不重试和取消。未进行手机真机或真实模型端到端验证。

## 自动化覆盖

2026-09-16 超时修复验证通过：353 项 Android JVM 测试、7 项 API 35 模拟器测试、64 项后端定向回归。提示词资产漂移、移动端能力契约和架构检查通过；Android Debug/测试构建及 Lint 通过。

- 同源契约：Android 构建资产直接导出 PC 工具目录、建档提示词、候选 schema、执行顺序、状态字段及长度限制。
- 两端业务结果：`contracts/fixtures/mobile-cataloging-v1.json` 是合成测试作品，同一计划分别经过 Android 资料投影与 PC 正式 applier；断言角色基础信息、状态、写作约束、版本、章/卷/场景绑定、角色关联和伏笔状态。
- Android JVM：不完整计划、其他作品的实体 ID、旧持有物保护、草稿按钮条件、正文版本推进，以及完整项目包的导出、导入、再次导出时保留角色和世界观关联。
- Android API 35 模拟器：无 Gateway 完成建档并解除下一章门槛；网络中断保留候选并明确重试；生成期间作者修改导致整章拒绝写入；取消与应用中断恢复；Room 3→5 迁移及旧版待同步正文的版本修复；连续正文保存、建档回执及后续作者编辑按顺序同步。
- 超时回归：`contracts/fixtures/agent-stream-idle-v1.json` 同时驱动 PC 实际 DeepSeek 适配器/网关和 Android MockWebServer，缩短等待时限，验证持续工具输出超过事件等待窗口仍完成、空心跳无效、中途停顿丢弃未完成工具缓冲、首个响应等待有界。另覆盖 Responses 持续输出与完成后连接未关闭、本地事件处理不消耗模型等待时限、普通请求保留原超时、作者可中断阻塞读取，以及两种 DeepSeek 协议的非思考参数。模拟器复现前 4 章已完成、第 5 章工具流中途超时，验证正式资料未发生部分写入，原候选保留，同一任务明确重试后完成。
- PC SQLite：过期正文、版本、档案和错误 ID 拒绝整章提交；失败没有部分领域写入；请求键重复不会重复更新版本或历史；同一失败请求在前提恢复后可以重试；新接口遵守已配对 Android 与已共享作品的边界。

## 复验命令

```powershell
backend\.venv\Scripts\python.exe scripts/export-mobile-prompt-contract.py
backend\.venv\Scripts\python.exe scripts/check-mobile-pc-parity.py --check-doc docs/mobile-pc-parity.md
backend\.venv\Scripts\python.exe -m pytest backend/tests/test_mobile_prompt_contract.py backend/tests/test_cataloging.py backend/tests/test_mobile_cataloging_commit.py backend/tests/test_local_cli_cataloging_agent.py backend/tests/test_cataloging_stream_idle_parity.py backend/tests/test_stream_timeout_retry_boundary.py -q
backend\.venv\Scripts\python.exe backend/scripts/run_quality.py
mobile\android\gradlew.bat -p mobile/android :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug --offline
```

在隔离模拟器中安装测试 APK 后执行 `MobileCatalogingInstrumentedTest` 和 `ProjectPackageChapterStateMigrationInstrumentedTest`。数据库测试使用内存数据库，网络同步测试使用本机 MockWebServer；没有读取或修改真实作品。

## 2026-10-16：固定建档回合的上下文预算

PC 固定建档与手机独立建档此前都可能把多轮候选提交和工具回执持续加入下一次请求，直到超过模型窗口。现在每步按当前模型容量、实际开放的工具 schema、消息、输出预留和安全余量核算；Android 复用现有 `MobileRequestBudgetEnvelope` 和 provider 请求序列化器，自动协议尚未确定时同时计量 Chat Completions 与 Responses，采用较大请求值。

超过预算时，两端采用 `cataloging_checkpoint.v1` 重建模型上下文：

- 保留完整章节和所有成功读取的档案；相同工具及精确参数的重复读取只保留一份，最近原生工具事务中已保留的读取不再重复放入检查点。
- 用当前完整候选及缺项诊断替代历史候选回执，保留当前选择的候选类型和最近完整 assistant/tool 事务，包含错误与待修正参数。
- 整理后每步刷新当前候选状态；原始调用记录完整保留在本机任务审计中。此过程不调用模型生成摘要，不截断正文或故事资料，也不更改完成条件。
- 完整必需资料仍放不下时，在 HTTP 发送前以 `conversation_required_state_over_capacity` 明确失败，保留正文与候选，供作者选择更大上下文后重试。只有模型显式 finalize 且工具校验通过才完成。

Android 的 Token 计量继续使用既有保守 UTF-8 字节上界，PC 本地模型可使用真实 tokenizer；因此两端可能在不同步骤整理历史，但资料完整性、暂停边界及最终业务结果一致。手机通过 Gateway 发起建档时使用后端同一修复，独立 API 模式不依赖 PC 运行。

验收通过 **12 项建档 JVM 测试**与 **3 项 API 35 隔离模拟器测试**，Debug 与 AndroidTest APK 编译通过。模拟器覆盖无 Gateway 的 64K 建档多轮历史整理、完整候选提交完成、原章不变且审计保留、分批同类提交及未开放工具纠正、失败保留计划后明确重试。测试模型由脚本返回结构化工具调用，数据库为 Room 内存库；未调用真实模型、未操作真实手机、未修改用户作品或升级生产安装。

本次定向日志：`.build/mobile-catalog-context-full-20261016.log`、`.build/mobile-catalog-context-instrumented-20261016.log`。

## 验证边界

这次自动化回归使用模拟的原生工具调用和网络故障，不代表真实模型端到端测试。既有 AI 实际运行测试主要基于 DeepSeek API 的 `deepseek-flash`；本次独立建档仍需用该模型在手机上验收。其他模型或 CLI 可能存在未知问题，不能将模拟测试解释为已经验证这些接入方式。

手机建档结果同步依赖 3.4.3 已提供的 PC/Gateway 建档接收适配器及授权路径；本轮超时修复未更改同步协议。
