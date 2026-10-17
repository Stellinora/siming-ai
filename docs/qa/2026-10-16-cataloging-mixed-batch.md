# 多章节建档遇到混合工具批次后立即暂停

## 用户反馈与定位

用户反馈一次选择多章时仅第一章成功，后续出现“建档写入或控制工具必须是模型步骤中唯一的业务调用，整批未执行”。未取得该用户的完整调用日志，不能断言其具体工具组合。

精确文案由 `workspace/native_tool_batch.py` 的 `cataloging_tool_must_be_only_call` 校验发出：结构合法的模型响应同时包含建档写入/控制工具和其他调用（包括两次保存）时整批拒绝。多个纯读取调用允许并批。该校验没有按章节序号限制成功数量。

PC 固定建档 Agent 仅捕获 `NativeToolBatchNotOpen`，没有处理这一普通 `NativeToolBatchValidationError`；它直接传播到 `_extract_run` 并将任务暂停，模型未得到纠正机会，失败批也没有记录到 `raw_output`。共享提示词和保存工具描述缺少单独写入的说明。Android 独立流程已有整批反馈和有限纠正，因此存在端间恢复差异。

## 隔离复现

第一章和“前章已完成”的第二章均可用一次 `save + read` 响应复现：一次请求即暂停，候选零写入，失败批原始记录缺失。`save + save` 同样触发；`get_next + archive` 允许。证据位于 `.build/cataloging-mixed-batch-diagnosis-20261016.json`。

触发来自模型输出的工具组合；司命应当说明调用规则，并将可修正错误交回同一模型。不得为了继续任务放宽写入边界、执行部分批次或由代码替模型拆分执行。

## 修复与验收

固定建档循环接收可恢复的整批校验错误：所有调用先完成基础结构和授权验证，拒绝批次内零执行，再为每个原始 call ID 返回 `executed=false`、具体 `reason` 和 `retryable`。由同一模型重新选择调用，应用不拆批代执行。相同错误累计三批后暂停，保留此前候选、全部模型调用和错误回执。

保存候选必须单独调用的规则已加入共享提示词和工具描述，并导出至手机资产；多个只读调用仍可同批。固定建档优先反馈未开放工具，包括已注册但不属于该任务的章节生成、草稿保存和类别切换工具。通用项目助手原有草稿/类别硬边界保持不变。

修正事件同步写入任务进度日志，便于区分正在修正和已终止。Android 独立建档使用同一错误语义，每个拒绝批次只计一次，混批计数与候选字段错误分开。

截至 2026-10-17 的验证结果：

- PC：79 项建档及相关回归、41 项通用原生工具边界回归通过。
- 新增 18 项混批回归，覆盖合法结构才可恢复、拒绝批次零执行、原 ID 回执、三次耗尽保留候选、完整审计和修正事件持久化。
- 临时 SQLite 和真实 `stream_cataloging_job` 编排器的三章测试，在第二章分别注入 `save + read`、`save + save`、`save + chapter_writer`、`save + save_external_chapter_draft`、`save + set_tool_categories`。模型收到回执并单独修正后，均完成 3/3；每例最终三个摘要、六条候选全部应用。
- Android：12 项建档 JVM 测试和 3 项 API 35 隔离模拟器测试通过，覆盖独立三章流程、第二章三种混批纠正后继续第三章、三批耗尽保留候选，以及原 64K 检查点回归。
- 核心变更 Ruff、架构检查及定向 diff 检查通过。另行只读审阅确认固定任务授权顺序与通用工作区边界。

上述混批回归使用可控模型响应，没有请求真实模型或写入用户作品。日志位于 `.build/catalog-mixed-all-20261016.log`、`.build/catalog-mixed-native-boundary-20261016.log`、`.build/mobile-catalog-batch-final-20261016.log` 和 `.build/mobile-catalog-batch-instrumented-20261016.log`。不能据此保证任意模型永远不产生错误工具组合；修复的是明确规则和可控恢复流程。

## 打包与安装

- PC 包已构建成功：`release/cataloging-fixes-20261017/Siming-Setup.exe`，保持版本号 3.5.1，包含此前本地建档上下文/冷启动修复。
- 构建架构检查 0 errors；打包后 MCP 冒烟验证 151 个工具通过。日志 `.build/cataloging-fixes-20261017-build.log`。
- 安装包 SHA256：`9c197afb4306abedd2863165055b35121048e263f8f3fb8e255c8a548e2b4cd3`；程序载荷 SHA256：`cb5aa260bf10c79fc5f6378df6f444ae784b4b8964f11b83eeceebae56e08a04`。
- 2026-10-17 作者退出主程序后继续覆盖安装。首次安装退出码 7：残留 `llama-server.exe`（父进程为已退出的 Siming）仍加载安装目录内的 `_internal/MSVCP140.dll`；安装器在清理旧版前安全停止。核对残留进程路径及无已建立连接后将其退出，重试安装成功，退出码 0。
- 已安装到现有安装目录，安装后的程序 SHA256 与上列载荷完全一致。日志 `.build/cataloging-fixes-20261017-install-final.log` 确认安装成功且无需重启系统。
- 安装前后作品/章节/大纲/角色/世界观数量保持 `27 / 505 / 1228 / 263 / 419`，数据库版本为 `300a40_recycle_bin`；未额外复制数据库。
- 启动后 `/health` 返回 `healthy`、版本 `3.5.1`、数据库 `ready` 且 `read_only=false`。本轮未自动重跑或修改作者建档任务。
