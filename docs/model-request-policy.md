# 模型请求参数策略

PC/Gateway 的 API 请求与手机独立 API 请求按实际接口地址和协议处理参数，不使用配置显示名称或模型名称识别服务商。未知中转地址保留显式参数和服务端默认值。

## 思考模式

| 实际地址与协议 | 自动关闭思考的范围 | 请求参数 |
| --- | --- | --- |
| `api.deepseek.com` / Chat Completions | 纯文本请求、建档 | `thinking: {type: disabled}` |
| `api.deepseek.com` / Responses | 纯文本请求、建档 | `reasoning: {effort: none}` |
| `api.siliconflow.cn` / Chat Completions | 建档 | `enable_thinking: false` |
| 其他地址或协议 | 不添加关闭思考参数 | 使用显式参数或服务端默认值 |

“纯文本”指请求没有提供工具，不根据用户文字判断任务。常规 Agent 工具回合不会因此关闭思考。PC 网关原有的 DeepSeek 仅思考且达到输出上限的单次补偿重试，也使用同一地址及协议策略；手机工具回合仍由作者明确重试，未新增自动补偿。

请求已带 `thinking`、`reasoning`、`reasoning_effort`、`enable_thinking` 或 `thinking_budget` 任一字段时，不再注入默认思考参数，也不改写显式值。调用方应传入实际协议支持的字段。

策略仅匹配 HTTPS、默认 443 端口及完整主机名。地址路径、子域名、配置显示名称或模型名称中出现 DeepSeek/Gemini，不会触发匹配。自定义名称连接真实官方地址仍会匹配。

## 工具选择参数

已知 DeepSeek 官方接口和 Gemini 官方 Chat Completions 接口保留既有策略：发送工具列表，省略不兼容的 `tool_choice`。未知中转保留请求值；只有服务端明确拒绝该字段时，才按现有机制调整一次。此规则不改变工具授权或原生工具能力校验。

## 权威实现与验证

- 权威定义：`backend/app/ai/request_policy.py`。适配器在实际协议的序列化处应用默认值，并移除内部 `moshu_*`、`local_cli_*` 元数据。
- 手机契约：`scripts/export-mobile-prompt-contract.py` 生成 `GeneratedModelRequestPolicy.kt`；`ModelRequestPolicy` 在手机本机执行，不依赖 PC 状态。旧的名称关键词判断和建档专用服务商列表已删除。
- 共用案例：`contracts/fixtures/model_request_policy_cases.json`，覆盖自定义名称、第三方中转、伪相似域名、两种协议、显式思考参数及不同任务。后端和 Android 测试检查实际发出的请求参数。
- 这些回归使用模拟响应，验证参数与协议一致性，不代表所有供应商模型的生成质量、速度或真实建档全流程已通过。

修改策略后运行导出脚本及 `test_mobile_prompt_contract.py`，确保 Android 契约没有漂移。本机 CLI/MCP 沿用原有工具契约，此 HTTP 参数策略不修改 CLI 自身的模型思考设置。
