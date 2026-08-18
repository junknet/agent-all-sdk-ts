# 三家 Agent 后端协议权威参考（agy / claude / codex）

> 本网关各出口的 wire 契约参考，记录本仓库代码所依赖的请求/响应字段形状。
> codex 侧字段以其开源实现(`codex-rs`, commit 2e84970)为准；其余各家以公开 SDK
> 与官方文档为准，字段随上游演进，以对应 provider 的回归测试为最终裁决。
> 最后核对 2026-06-02。Antigravity 后端区分 `daily-cloudcode-pa` 与 `cloudcode-pa`，模型集合一致。

---

## 0. 一句话定位

| | agy (Antigravity) | claude (Claude Code) | codex (OpenAI Codex) |
|---|---|---|---|
| 后端 | Google cloudcode-pa (Gemini 私有面) | Anthropic Messages API | OpenAI Responses API |
| 协议 | `v1internal:streamGenerateContent` SSE(JSON) | `/v1/messages` SSE | `/responses` SSE |
| 多厂商 | 是(Gemini+Claude+GPT-OSS 都代理) | 否 | 否(但支持 oss/ollama provider) |

---

## 1. 鉴权

### 1.1 agy — Google OAuth + cloudaicompanion project

- **OAuth authorize**：`https://accounts.google.com/o/oauth2/auth`
  - `client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
  - `redirect_uri=https://antigravity.google/oauth-callback`
  - `response_type=code`，**PKCE** `code_challenge_method=S256`，`access_type=offline`，`prompt=consent`
  - `scope = cloud-platform userinfo.email userinfo.profile cclog experimentsandconfigs openid`
- **token exchange / refresh**：`https://oauth2.googleapis.com/token`（grant_type=authorization_code / refresh_token）
- **本地凭证(可复用)**：`~/.gemini/oauth_creds.json` = `{access_token(ya29.), token_type:"Bearer", refresh_token(1//0g.), id_token(JWT), scope, expiry_date(epoch ms)}` — gemini-cli/SDK 共享。
- **调用头**：`Authorization: Bearer <access_token>`，`User-Agent: antigravity/cli/1.0.4 linux/amd64`。
- **project 解析**：先 `v1internal:loadCodeAssist`/`listCloudAICompanionProjects` 拿 `project`，每次请求体顶层带 `project`。
- ⚠ 坑：某些 tun 模式代理下 `oauth2.googleapis.com/token` 链路不稳(握手/io timeout)，而 `cloudcode-pa`/`www.googleapis.com` 通畅 → **优先复用 oauth_creds.json 的未过期 access_token，不要每次走 token endpoint**。

### 1.2 claude — Anthropic OAuth(Claude Max/Pro) 或 API Key

- **本地凭证**：`~/.claude/.credentials.json` → `claudeAiOauth = {accessToken, refreshToken, expiresAt(epoch ms), scopes[], subscriptionType("max"), rateLimitTier("default_claude_max_20x")}`
- **OAuth scopes**：`user:inference user:file_upload user:mcp_servers user:profile user:sessions:claude_code`
- **调用头(OAuth 模式)**：
  - `Authorization: Bearer <accessToken>`
  - `anthropic-version: 2023-06-01`
  - `anthropic-beta: oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24`
  - OAuth 专有：`X-Claude-Code-Session-Id`、`x-client-request-id`、`x-app=cli`
- **调用头(API Key 模式)**：`x-api-key: <key>`，`anthropic-beta: prompt-caching-2024-07-31,thinking-2025-02-19`
- **refresh**：`https://platform.claude.com/v1/oauth/token`（OAuth 模式）。
- 端点：`https://api.anthropic.com/v1/{messages,models}`，OAuth token **可直接调** `/v1/models`、`/v1/messages`（实测 200）。

### 1.3 codex — ChatGPT OAuth 或 OpenAI API Key

- **本地凭证**：`~/.codex/auth.json` = `{auth_mode("chatgpt"|"apikey"), OPENAI_API_KEY(null|sk-), tokens:{id_token(JWT), access_token(JWT), refresh_token, account_id(uuid)}, last_refresh(RFC3339)}`（`login/src/auth/storage.rs:44`）
- **refresh**：`POST https://auth.openai.com/oauth/token`，body `{client_id:"app_EMoamEEZ73f0CkXaXp7hrann", grant_type:"refresh_token", refresh_token}`（`login/src/auth/manager.rs:82,712`）。可被 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 覆盖。
- **过期判断**：JWT `exp` claim vs now；无 exp 则 `last_refresh < now-8d`（`manager.rs:1414`）。
- **id_token claims**：`https://api.openai.com/auth.chatgpt_plan_type`(free/plus/pro/team/business/enterprise/edu)、`.chatgpt_account_id`、`.chatgpt_user_id`（`token_data.rs:97`）。
- **调用头**：`Authorization: Bearer <access_token>`，`ChatGPT-Account-Id: <account_id>`，`Accept: text/event-stream`，`x-client-request-id`/`session_id`=conversation_id，可选 `x-openai-subagent`、`OpenAI-Organization`/`OpenAI-Project`(env)。

---

## 2. 端点 / base_url

| | base_url | 路径 |
|---|---|---|
| agy | `https://daily-cloudcode-pa.googleapis.com`(canary) 或 `https://cloudcode-pa.googleapis.com`(prod) | `/v1internal:streamGenerateContent?alt=sse`、`:fetchAvailableModels`、`:countTokens`、`:generateContent`、`:loadCodeAssist`、`:listCloudAICompanionProjects` |
| claude | `https://api.anthropic.com` | `/v1/messages`、`/v1/models`、`/v1/messages/batches?beta=true` |
| codex(OAuth) | `https://chatgpt.com/backend-api/codex` | `/responses`、`/models`（`model_provider_info.rs:165`）|
| codex(APIKey) | `https://api.openai.com/v1` | `/responses`、`/models`（`model_provider_info.rs:167`）|

---

## 3. 模型（全部实测 ground truth）

### 3.1 agy — `fetchAvailableModels` 实测（精选；完整见 `logs/models_daily.json`）

| wire id (请求 `model`) | displayName | model_enum | img | video | think | tbDefault | tbMin | maxOut | apiProvider |
|---|---|---|:-:|:-:|:-:|--:|--:|--:|---|
| `gemini-3-flash` | Gemini 3 Flash | MODEL_PLACEHOLDER_M18 | ✓ | ✓ | ✓ | -1(动态) | 32 | 65536 | GOOGLE_GEMINI ⭐recommended |
| `gemini-3-flash-agent` | **Gemini 3.5 Flash (High)** | M132 | ✓ | ✓ | ✓ | **10000** | 32 | 65536 | GOOGLE_GEMINI |
| `gemini-3.5-flash-low` | **Gemini 3.5 Flash (Medium)** | M20 | ✓ | ✓ | ✓ | **4000** | 32 | 65536 | GOOGLE_GEMINI |
| `gemini-3.5-flash-extra-low` | **Gemini 3.5 Flash (Low)** | M187 | ✓ | ✓ | ✓ | **1000** | 32 | 65536 | GOOGLE_GEMINI |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | M37 | ✓ | ✓ | ✓ | 10001 | 128 | 65535 | GOOGLE_GEMINI |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | M36 | ✓ | ✓ | ✓ | 1001 | 128 | 65535 | GOOGLE_GEMINI |
| `gemini-pro-agent` | Gemini 3.1 Pro (High) | M16 | ✓ | ✓ | ✓ | 10001 | 128 | 65535 | GOOGLE_GEMINI |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | M50 | ✗ | ✗ | ✗ | — | — | 65535 | GOOGLE_GEMINI |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | M21 | ✗ | ✗ | ✗ | — | — | — | GOOGLE_GEMINI(图像生成) |
| `gemini-2.5-pro` | Gemini 2.5 Pro | GOOGLE_GEMINI_2_5_PRO | ✓ | ✗ | ✓ | 1024 | 128 | 65535 | GOOGLE_GEMINI |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | M35 | ✓ | ✗ | ✓ | 1024 | — | 64000 | (Anthropic 经 Google 代理) |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | M26 | ✓ | ✗ | ✓ | 1024 | — | 64000 | (Anthropic 经 Google 代理) |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | OPENAI_GPT_OSS_120B_MEDIUM | ✗ | ✗ | ✓ | 8192 | — | 32768 | OPENAI |

- **推理等级 = thinkingBudget(token 预算)**，不是离散枚举。同一逻辑模型(Gemini 3.5 Flash)三档 = 三个不同 wire id + 不同默认 budget(1000/4000/10000)。`thinkingBudget=-1` 表示动态。`maxTokens(输入上下文)=1048576`，`tokenizerType=LLAMA_WITH_SPECIAL`。
- **服务端回报**：请求 `model:"gemini-3-flash-agent"` → 响应 `modelVersion:"gemini-3-flash-a"`（`-a`=agent 简写）。
- **多模态**：supportsImages/Video + `supportedMimeTypes`(31 种：image/jpeg|png|webp|heic|heif、video/mp4|webm、audio、application/pdf、各 text/code)。

### 3.2 claude — `/v1/models` 实测

`claude-opus-4-8`(Opus 4.8) · `claude-opus-4-7` · `claude-opus-4-6` · `claude-opus-4-5-20251101` · `claude-sonnet-4-6` · `claude-sonnet-4-5-20250929` · `claude-haiku-4-5-20251001` · `claude-opus-4-1-20250805` · `claude-opus-4-20250514` · `claude-sonnet-4-20250514`

### 3.3 codex — `/models` + 源码能力矩阵（`protocol/src/openai_models.rs:243`）

内置 slug：`gpt-5` `gpt-5.1` `gpt-5.1-mini` `gpt-5.1-pro` `o3-mini` `o3-mini-high` `gpt-4.5-turbo` `codex-*`（用户本地 config.toml=`gpt-5.5`）。
每模型 metadata：`slug` `display_name` `default_reasoning_level` `supported_reasoning_levels[]` `supports_reasoning_summaries` `support_verbosity` `supports_parallel_tool_calls` `context_window` `input_modalities[text,image]` `web_search_tool_type` `apply_patch_tool_type(freeform|function)` `truncation_policy`。

---

## 4. 请求体 wire 格式

### 4.1 agy (streamGenerateContent)
```jsonc
{
  "model": "gemini-3-flash-agent",
  "project": "<cloudaicompanion project>",
  "requestId": "agent/<sessionUUID>/<ms>/<trajectoryUUID>/<seq>",
  "sessionId": "<int64 str>", "userAgent": "antigravity", "requestType": "agent",
  "request": {
    "contents": [{"role":"user|model", "parts":[{"text"|"functionCall"|"functionResponse"|"thoughtSignature"|"inlineData"}]}],
    "systemInstruction": {"role":"user","parts":[{"text":"<identity>You are Antigravity..."}]},
    "tools": [{"functionDeclarations":[{"name","description","parameters":{type:"OBJECT",properties,...}}]}],
    "toolConfig": {"functionCallingConfig":{"mode":"VALIDATED"}},   // 或 AUTO/ANY/NONE
    "generationConfig": {"maxOutputTokens":65536,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":10000}},
    "labels": {"model_enum":"MODEL_PLACEHOLDER_M132","used_claude":"false","trajectory_id","last_step_index","last_execution_id"}
  }
}
```

### 4.2 claude (/v1/messages)
```jsonc
{
  "model":"claude-opus-4-6","max_tokens":64000,"stream":true,
  "system":[{"type":"text","text":"...","cache_control":{"type":"ephemeral"}}],
  "messages":[{"role":"user","content":[{"type":"text","text":"..."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]}],
  "tools":[{"name","description","input_schema":{...},"cache_control":{"type":"ephemeral"}}],
  "tool_choice":{"type":"auto"},
  "thinking":{"type":"enabled","budget_tokens":<int>}
}
```

### 4.3 codex (/responses)  —  `codex-api/src/common.rs:154`
```jsonc
{
  "model":"gpt-5.1","instructions":"<base system>","stream":true,"store":false,
  "input":[ /* ResponseItem[] 见 §5.3 */ ],
  "tools":[{"type":"function","name","description","parameters":{...},"strict":false}],
  "tool_choice":"auto","parallel_tool_calls":true,
  "reasoning":{"effort":"medium","summary":"auto"},
  "text":{"verbosity":"medium"},                  // 可选; 也可放 format(JSON schema)
  "include":["reasoning.encrypted_content"],       // 可选
  "prompt_cache_key":"<opaque>",                   // 可选
  "service_tier":"default"                          // 可选
}
```

---

## 5. SSE 事件 + function/tool call 格式

### 5.1 agy
- 帧：`data: {response:{candidates:[{content:{parts:[...]},finishReason}], usageMetadata, modelVersion, responseId, traceId}}`
- part 三型：`{text}` / `{functionCall:{name,id,args}}` / `{thoughtSignature:<base64加密思维链>}`
- 工具回传：`contents[].parts[].functionResponse:{name,id,response}`
- usage：`{promptTokenCount,candidatesTokenCount,totalTokenCount,thoughtsTokenCount}`（思考 token 单列）
- finishReason：`STOP` 等

### 5.2 claude
- 事件：`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`；错误 `error`
- delta 子型：`text_delta` / `thinking_delta` / `input_json_delta`(工具入参增量) / `signature_delta`
- 工具：content block `{type:"tool_use",id,name,input}`；回传 `{type:"tool_result",tool_use_id,content,is_error}`
- usage 在 `message_start.message.usage` + `message_delta.usage`：`{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`

### 5.3 codex（`type` 字符串，`core/tests/common/responses.rs`）
- `response.created` / `response.output_item.added` / `response.output_item.done` / `response.output_text.delta` / `response.reasoning_summary_text.delta`(含 summary_index) / `response.reasoning_text.delta`(含 content_index) / `response.completed`(含 usage) / `response.failed`
- input/output item 类型(`protocol/src/models.rs`)：`message`(content: `input_text`/`input_image{image_url}`/`output_text`) · `function_call{name,arguments,call_id}` · `function_call_output{call_id,output(str|content[])}` · `reasoning{id,summary[],content?,encrypted_content}` · `custom_tool_call(_output)` · `local_shell_call` · `web_search_call` · `image_generation_call` · `compaction{encrypted_content}`
- usage：`usage.input_tokens` + `input_tokens_details.cached_tokens` + `output_tokens` + `output_tokens_details.reasoning_tokens` + `total_tokens`

---

## 6. 推理 / 思考预算

| | 字段 | 取值 |
|---|---|---|
| agy | `generationConfig.thinkingConfig.{includeThoughts(bool), thinkingBudget(int)}` | budget=token 数(1000/4000/10000…，-1 动态)，minThinkingBudget=32/128 |
| claude | `thinking.{type:"enabled", budget_tokens:int}` | budget_tokens 整数；beta `interleaved-thinking-2025-05-14`、`effort-2025-11-24` |
| codex | `reasoning.{effort, summary}` | effort: `none/minimal/low/medium/high/xhigh`；summary: `auto/concise/detailed/none` |

> 统一抽象建议：`ReasoningEffort{none,minimal,low,medium,high,xhigh}` + `ThinkingConfig{IncludeThoughts,BudgetTokens}`。映射：codex 直接用 effort；claude/agy 把 effort→budget_tokens（agy 还要换 wire id：low→extra-low, medium→low, high→agent）。

---

## 7. Prompt Caching

| | 支持 | 机制 |
|---|---|---|
| agy | **否** | fetchAvailableModels 与 SSE 均无 cache 字段；cloudcode 私有面不暴露 cachedContent |
| claude | 是 | 请求 `cache_control:{type:"ephemeral"}`(挂 system/tool/message 末尾，≤4 断点)；读 `cache_creation_input_tokens`/`cache_read_input_tokens`；beta `prompt-caching-scope-2026-01-05` |
| codex | 是(半自动) | 请求 `prompt_cache_key`(调用方设)；读 `input_tokens_details.cached_tokens` |

---

## 8. 图片 / 多模态

| | 输入图片 | 视频 | 其它 |
|---|---|---|---|
| agy | ✓(supportsImages) | ✓(部分模型 supportsVideo) | 31 MIME：pdf/audio/code/csv… `parts[].inlineData{mimeType,data}` |
| claude | ✓ `content[].image.source{base64,media_type}` | ✗ | file_upload scope；PDF via documents |
| codex | ✓ `input_image{image_url:"data:image/..;base64,.."}` | ✗ | `input_modalities:[text,image]`；`view_image` 工具 |

---

## 9. 你 SDK 的待修正清单

### provider/antigravity
1. **删除/修正注释 "google returns no modelVersion"** — 实测返回 `modelVersion`（gemini-3-flash-a），`streamCollect` 应解析回填。
2. `buildEnvelope` 补全顶层 `requestType:"agent"`、`userAgent:"antigravity"`、`request.toolConfig.functionCallingConfig.mode`、`generationConfig.thinkingConfig`、`labels.model_enum`。
3. `modelRouting` 补 thinkingBudget：extra-low=1000 / low=4000 / agent=10000（min 32），并考虑 Pro 三档(low/high/agent) 与 gemini-3-flash(动态-1)。
4. `ListModels` 改为真打 `v1internal:fetchAvailableModels`（已验证可用），别 hardcode。

### provider/codex（源码比对，13 项，重点）
1. **prompt_cache_key** 请求字段缺失 → 补。
2. **reasoning.summary**(auto/concise/detailed/none) 请求 + `response.reasoning_summary_text.delta` 解析缺失 → 补；reasoning item 的 `encrypted_content` 需在 store=false 时回传。
3. **text.{verbosity,format}** 完全缺失。
4. input item 仅支持 message/function_call_output → 补 `custom_tool_call_output`/`local_shell_call`/`web_search_call`/`image_generation_call`。
5. usage 修正：`reasoning_tokens` 来自 `output_tokens_details`（非 input）。
6. tool 定义补 `strict`；`include` 标志缺失；`service_tier` 缺失。
7. effort 枚举加 `none/minimal/xhigh`（schema 已有 xhigh，codex transform 要透传全集）。

### provider/claude
- 基本完整。补：thinking summary 提取；cache 断点上限按 `prompt-caching-scope-2026-01-05` 放宽；OAuth headers(`X-Claude-Code-Session-Id`,`x-app=cli`) 确认已带。

### schema（统一层）
- `ReasoningEffort` 已含 `none..xhigh` ✓。补 `ReasoningSummary` 枚举(codex 用)。
- `Usage` 已有 `CachedTokens/ReasoningTokens` ✓。
- `ContentPart` 多模态 `Image{Data,MimeType}` ✓；视频仅 agy 需要，可后置。
- `ModelInfo` 过简(仅 ID/Name)；建议加 `DisplayName/SupportsImages/SupportsThinking/DefaultThinkingBudget/MaxOutputTokens/ContextWindow`，承载三家 metadata。

---

## 10. claude 字段补充（工具往返 + 图片输入）

> 修正 §1.2/4.2/5.2 中此前基于文档的推断。

- **URL**：`POST https://api.anthropic.com/v1/messages?beta=true`
- **OAuth token 前缀**：`Authorization: Bearer sk-ant-oat01-...`（oat=oauth access token，非 ya29）
- **anthropic-beta 实测全串**：`claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,...`（含 **context-1m** 1M 上下文）
- **官方 SDK 指纹**：`User-Agent: claude-cli/2.1.160 (external, cli)` + 全套 `X-Stainless-*`(Lang:js, Runtime:node v24.3.0, Package-Version:0.94.0) → CLI 用 Anthropic 官方 TS SDK(Stainless 生成)
- **专有头**：`x-app: cli`、`X-Claude-Code-Session-Id`、`x-client-request-id`
- **请求体新字段（之前没捕获）**：
  - `thinking: {"type":"adaptive"}` ← **自适应**模式，不是 `{type:"enabled",budget_tokens}`！配 `output_config:{"effort":"high"}` 控制。
  - `context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` ← 服务端上下文管理(清思考)
  - `metadata: {"user_id":"{device_id,account_uuid,...}"}`、`diagnostics:{"previous_message_id"}`
  - system 是数组，首块是 `x-anthropic-billing-header: cc_version=...;cc_entrypoint=cli`，带 3 处 `cache_control:{type:"ephemeral"}`
- **SSE 事件序列(实测)**：`message_start → content_block_start → ping → content_block_delta* → content_block_stop → (content_block_start → delta* → stop)… → message_delta → message_stop`
  - content_block 类型：`thinking` / `tool_use` / `text`
  - delta 类型：`text_delta` / `thinking_delta` / `input_json_delta`(工具入参) / `signature_delta`(思考签名)
- **usage(缓存 ground truth)**：`{input_tokens, cache_creation_input_tokens:1709, cache_read_input_tokens:28258, cache_creation:{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens:1709}, output_tokens, output_tokens_details:{thinking_tokens:9}}` — **缓存命中 28258 token**；ephemeral 分 5m/1h 两种 TTL。
- **tool_use**：`{type:"tool_use", id:"toolu_01...", name:"Write", input:{...}, caller:{type:"direct"}}` ← 多了 `caller` 字段
- **tool_result**：`{type:"tool_result", tool_use_id:"toolu_...", content: "<str>" | [{type:"text"}|{type:"image",source:{type:"base64",media_type:"image/png",data:"iVBOR.."}}]}`
- **图片输入**：claude 读图经 **Read tool → tool_result.content[] 里回传 image block**(base64 png)，非顶层 user image block。

---

## 11. codex 字段补充（Responses API 实际取值）

> 与 §4.3/5.3 的源码规格一致，此处补充各字段的典型取值。

- **请求头**：`authorization: Bearer sk-...`(apikey 模式，**无** ChatGPT-Account-Id)、`originator: codex-tui`、`user-agent: codex-tui/0.136.0 (Manjaro...; x86_64) tmux/3.6a`、`accept: text/event-stream`、`x-client-request-id`
- **请求体实测**(顶层字段全部对上源码)：
  ```jsonc
  { "model":"gpt-5.5", "instructions":"<21335B: You are Codex, a coding agent based on GPT-5...>",
    "input":[ /* 21 items */ ], "tools":[ /* 15 个, 全 type:function */ ],
    "tool_choice":"auto", "parallel_tool_calls":true,
    "reasoning":{"effort":"high"}, "store":false, "stream":true,
    "include":["reasoning.encrypted_content"],          // store=false → 回传加密思维链
    "prompt_cache_key":"019e8946-...",                   // == x-client-request-id
    "text":{"verbosity":"low"},
    "client_metadata":{"x-codex-installation-id":"..."} }
  ```
- **input item 实测类型**：
  - `message{role:"developer"|"user"|"assistant", content:[{type:"input_text",text}]}`（system 走 developer 角色）
  - `reasoning{summary:[], content:null, encrypted_content:"gAAAAA.."}` ← Fernet 加密思维链
  - `function_call{name:"exec_command", arguments:"{\"cmd\":\"pwd && ls\",\"workdir\":..}"}`
  - `function_call_output{call_id, output}`
  - `custom_tool_call{status,call_id,name:"apply_patch",input:"*** Begin Patch.."}` ← **apply_patch 是 custom_tool_call**(非 function)
  - `custom_tool_call_output{call_id, output:"Exit code:0.."}`
- **tools 实测**：15 个全 `type:"function"`，如 `{type:"function",name:"exec_command",description:"Runs a command in a PTY...",strict:false,parameters:{...}}`
- **SSE 事件实测**：`response.created → response.in_progress → response.output_item.added → response.content_part.added → response.output_text.delta(×94) → response.output_text.done → response.content_part.done → response.output_item.done → response.completed`（比源码 agent 列的多 `response.in_progress`、`response.content_part.added/done`）
- **usage 实测**：`{input_tokens:18661, input_tokens_details:{cached_tokens:17792}, output_tokens:159, output_tokens_details:{reasoning_tokens:57}, total_tokens:18820}` — **缓存命中 17792 token**(prompt_cache_key 生效)，reasoning_tokens 单列。

> 注：codex CLI 发出的是标准 Responses API，wire 格式与直连 OpenAI 一致。`apply_patch`/`exec_command` 是 codex 改文件/跑命令的核心工具。
