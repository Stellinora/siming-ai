# 项目审查修复记录 — 2026-10-13

对应 [审查报告](./2026-10-13-project-review.md) 的 F01–F11。本轮已修改工作区代码并完成下述自动化验证；PC 安装包已重新生成，尚未安装或发布。

## 修复内容

| 审查项 | 当前实现 |
| --- | --- |
| F01 错章保存 | 章节读取、历史恢复和保存响应绑定编辑器所属作品/章节；读取及恢复还校验请求序号、编辑修订。保存前验证详情 ID 与当前目标一致。 |
| F02 未保存修改丢失 | 后台刷新保留脏正文和大纲表单；正文只更新同版本的只读建档信息。保存只清除本次提交对应修订的脏状态。 |
| F03 建档假完成 | REST 与 Agent 工具共用候选审核服务。调用方只能设置审核状态，不能设置 applying/applied/apply_failed；已应用候选不可编辑。应用阶段检查写入日志，并检查正式章节摘要存在。 |
| F04 手机字段丢失 | 角色说话风格、动机和冲突按 PC 契约写入背景；嵌套 AI 配置在同一 Room 事务内形成正式配置及同步任务，更新时保留未修改字段。角色及大纲工具回执读取实际保存记录。 |
| F04 大纲人物关联 | PC/手机的 update_outline_node 统一使用 character_ids。手机将明确提交的 ID 转成关联记录并替换旧关联；空数组清除关联。两端拒绝不存在、跨作品及重复 ID。生成新大纲草稿的角色规划契约不属于此更新工具。 |
| F05 重试叠加 | OpenAI 兼容 SDK 与 Anthropic SDK 均设置 max_retries=0，由模型网关管理重试。模拟 503 时 retry=0 为 1 次 HTTP 请求，retry=3 为 4 次。 |
| F06 思考误判空闲 | 文本流通过空字符串传递传输活动，网关刷新空闲等待但不向正文输出思考内容。覆盖 OpenAI 兼容及 Anthropic 文本流；Responses 识别 reasoning_summary_text/reasoning_text。 |
| F07 截断当成功 | 非流式 API 在交付正文/工具前检查 finish_reason、status 或 stop_reason。未完成结果抛出明确错误，PC 网关不会对此执行相同请求的传输重试；手机 Chat/Responses 同样拒绝未完成结果。 |
| F08 错误范围扩大 | 显式 ID 列表逐项校验存在与作品归属，不再静默过滤；错误 ID 不会变成空列表并扩大到整书。现有接口的未指定/空列表全书选择约定保持明确，空作品拒绝启动。 |
| F09 取消后复活 | 跳过和恢复人工审核共用状态边界，以数据库条件更新锁定可审核任务，再读取真实章节状态。取消、完成或状态已变化时拒绝操作；合法转入活动状态会清除终态时间。 |
| F10 拆书私有参数 | 删除按模型名称包含 deepseek 注入 thinking 的三处逻辑，只声明 deconstruct 任务，具体参数继续由统一 endpoint/protocol 策略生成。 |
| F11 发布检查 | 拆分超长网关方法，修正跨端契约中的旧测试名称。PC/Android 打包入口共用 check-release-preflight.ps1，检查架构、跨端契约及生成的上下文/提示词策略。 |

## 验证

- 建档与模型调用相关扩大回归：390 项通过。
- 最终供应商适配、SDK 请求次数、未完成响应、原生协议及配置回归：135 项通过。
- 建档控制与大纲等最终针对性复查：64 项通过。以上后端集合有重叠，不累计为唯一测试数。
- 写作、大纲及编辑器归属回归：33 项通过。
- Android 全部 JVM 单元测试：376 项通过，0 失败/错误/跳过。
- 新增 Room 独立持久化 instrumentation 测试已编译，包括角色配置事务回滚及关联清空；**尚未执行真机测试**，ADB 当前设备列表为空。
- 后端正式质量门禁（架构、提示词编译/预算、指定范围 Ruff、import-linter）、前端架构、TypeScript、OpenAPI 类型一致性均通过。
- 打包预检通过：跨端契约 28 项能力、生成文件一致性及后端架构。
- `git diff --check` 通过。

验证使用隔离数据库和模拟供应商响应，未调用真实付费模型，也未写入用户小说库。没有重复执行完整手机立项到前三章流程；手机与真实 API 的现场验收仍需在后续安装测试中完成。

## 回归入口

- `backend/tests/test_review_cataloging_boundaries.py`
- `backend/tests/test_review_model_transport.py`
- `frontend/src/__tests__/EditorRequestOwnership.test.tsx`
- `mobile/android/app/src/test/java/com/siming/mobile/data/network/WorkspaceWriteContractTest.kt`
- `mobile/android/app/src/androidTest/java/com/siming/mobile/WorkspaceToolPersistenceTest.kt`

后续打包会自动执行预检；也可在仓库根目录运行 `./scripts/check-release-preflight.ps1`。该预检检查构建边界与生成契约，不替代回归测试和真机验收。

## PC 重新打包

- 版本：3.5.1，包含本次工作区修复。
- 安装包：`release/review-fixes-20261013/Siming-Setup.exe`（46.8 MiB）。
- SHA256：`9b47d67ad42370b2ccc78fe80ddcc0aeffeada0abc8d38d5f454c47db12c8d6f`。
- 权威构建入口 `scripts/build-installer.ps1` 成功；构建预检、打包程序 MCP 冒烟测试（151 个工具）及安装包校验值验证通过。
- 构建日志：`.build/review-fixes-20261013-package.log`。本次仅打包，未安装、推送或发布。
