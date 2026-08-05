# agent-all-sdk-ts

多厂商 LLM 协议网关（TypeScript / Bun）。前端同时讲 **Anthropic Messages / OpenAI Chat
Completions / OpenAI Responses** 三套协议，后端把请求路由到 **Claude / Codex(ChatGPT) /
Gemini** 各家，用 **Anthropic 格式作为统一中间表示（canonical IR）**双向翻译流式报文——含工具
调用、思考/reasoning、图片，并逐项修正各家 wire 的脏细节。

> 这是**完整私有版**（含 Claude 出口 + gemini 评测路由逻辑）。对外脱敏精简版见
> [`llm-wire-gateway`](https://github.com/junknet/llm-wire-gateway)（出口仅 GPT/Gemini，去敏感）。

## 架构：单 IR + 多后端（LLVM 模型）

```
  入口协议 (inbox)              统一 IR             出口后端 (outbox)
  ├ POST /v1/messages   ┐                    ┌ anthropic-passthrough (Claude)
  ├ POST /v1/chat/...   ┼─ decode ─► Anthropic ─ encode ─┼ codex (ChatGPT Responses)
  └ POST /v1/responses  ┘          canonical          ├ openai-compat (OpenAI/Gemini-OAI)
                                                       ├ antigravity (Gemini CloudCode)
                                                       └ windsurf → agent-ir (Connect/protobuf)
```

- IR = Anthropic Messages 格式（注释里称 `Anthropic-canonical`）。
- 后端契约 = `WireProvider`：`buildRequest`（IR→厂商 wire）+ `parseStream`（厂商 SSE→IR）。
- `createWireAdapter` 串起整条管线（解码→压图→选 provider→重试→回流 IR SSE）。

## 目录树（单向递降，facade 先行）

```
src/
├ index.ts        ── facade：pickWireProvider 选后端 · createWireAdapter 管线 · resolveModel/latestUserInput 路由
├ server.ts       ── 入口：Bun.serve，三协议 HTTP 端点 → index.ts
├ types.ts        ── L0 IR 类型契约（AnthropicMessagesRequest / WireProvider / …）
├ emitter.ts      ── Anthropic SSE 事件发射器（旧 provider 的目标）
├ sse.ts          ── SSE 解析原语（iterSSE / tryParseJSON）
├ auth.ts         ── 本地凭据探测 + OAuth 刷新（Claude / Codex Source）
├ logging.ts      ── Pino 日志装配：等级、格式、脱敏与每请求 trace 上下文
├ image_compress.ts ── 入站图片自动压缩（magick，可选）
├ passthrough.ts  ── 非 /v1/messages 请求直透判定
├ responses_api.ts ── OpenAI Responses ⇄ canonical 编解码（兼容入口用）
└ providers/      ── L2 后端实现，各自一家厂商 wire
   ├ antigravity_provider.ts        ── Gemini via Google CloudCode
   ├ codex_responses_outbox.ts      ── ChatGPT OAuth、账户头与 agent-ir Responses Outbox 装配
   ├ codex_models.ts                ── ChatGPT Codex 模型目录与映射
   ├ openai_responses_outbox.ts     ── 标准 Responses 的 agent-ir 装配
   ├ openai_compat_provider.ts      ── OpenAI Chat Completions / Gemini-OAI
   ├ anthropic_passthrough_provider.ts ── Claude（OAuth / API key 直透）
   └ windsurf_agent_ir_provider.ts  ── Windsurf Connect/protobuf（由 agent-ir 编译与读取）
```

**import 方向（单向，无环）**：`types` ← 所有；`emitter/sse/auth` ← `providers`；
`providers/emitter/passthrough/logging/image_compress/auth` ← `index`；
`index/sse/responses_api/providers/auth/logging` ← `server`。同层不横向 import。

## 日志（Pino）

日志只写进程标准错误，不创建 NDJSON 文件，也不保存请求、工具结果或 SSE 正文。`server.ts`
在启动时创建根 Pino logger，并为每个请求注入 `trace`、入口协议、模型、会话和 Outbox 上下文；
下游只接收这个 child logger。鉴权头会在进入日志字段前脱敏，SSE trace 仅记录序号和字节数。

- `AGENT_GATEWAY_LOG_LEVEL=trace|debug|info|warn|error`，默认 `info`。
- `AGENT_GATEWAY_LOG_FORMAT=text|json`，默认便于终端阅读的 `text`；生产采集器使用 `json`。
- `debug`：入站解码、瘦身、出站编译与请求开始；`info`：响应状态和请求完成；`warn`：有损
  IR 翻译、未识别流事件、重试；`error`：鉴权、出站、流转换失败。

## 网关侧路由逻辑（本版特有，`index.ts`）

- **模型重映射** `MODEL_REMAP`：客户端的 haiku 类背景模型 → 最便宜的 gemini 挡，省钱且不污染 gemini 评测。
- **「思考」升档** `resolveModel` + `latestUserInput`：用户**最近一次输入**含「思考/深思/think hard/
  ultrathink」时，把当次 flash 低挡升到高挡（`gemini-3-flash-agent`），且**只罩这一轮 agent loop**——
  下次普通输入即回落（状态机，非历史粘滞；tool_result 不算人类输入）。Pro 挡永不被升档拉低。
- **Gemini thoughtSignature 缓存**（`antigravity_provider.ts`）：Gemini 多轮推理依赖每个 functionCall 的
  `thoughtSignature`，但它无法穿过 codex/openai 往返。网关按 `call_id` 服务端缓存真签名、replay 时贴回，
  替掉 `skip_thought_signature_validator` 占位——否则跨轮推理链断裂会导致重复规划 / MALFORMED / 400。
- **DeepSeek 双平台出口（model 前缀区分）**：不带前缀的 `deepseek-v4-flash` / `deepseek-v4-pro`
  默认走官方 Anthropic 兼容 API `https://api.deepseek.com/anthropic`；显式
  `official/deepseek-v4-flash`、`official/deepseek-v4-pro` 也走官方。官方 API 的实际
  model id 是小写 `deepseek-v4-flash` / `deepseek-v4-pro`，文档里的
  `DeepSeek-V4-Flash-0731` 是模型版本标签，不是可传给官方 API 的 id。
- **百炼前缀**：`bailian/deepseek-v4-flash-0731` 走
  `https://dashscope.aliyuncs.com/compatible-mode/v1`，使用 `DASHSCOPE_API_KEY`、
  `DASHSCOPE_BASE_URL`、`DASHSCOPE_MODEL`（可选）配置。百炼出口只接受明确的
  `bailian/` 前缀，不会把其他模型目录污染到本路由。
- **OpenRouter 前缀**：`openrouter-<sanitized-upstream>` 走
  `https://openrouter.ai/api/v1`（OpenAI 兼容），使用 `OPENROUTER_API_KEY`，可选
  `OPENROUTER_BASE_URL` 覆盖。OpenRouter 的原生 model id 形如
  `vendor/model[:variant]`（如 `deepseek/deepseek-v4-flash-20260731:nitro`，
  `:nitro` 是选高吞吐供货商的 provider-routing 后缀），但发布的网关 id 必须
  dash-only（见 `model_registry.ts` 头注释：OMP 的 proxy discovery 会丢弃含 `/`
  的 id）。因此发布 id 把 upstream 里的 `/` 与 `:` 都替换成 `-`
  （`sanitizeUpstreamForId`），例如
  `openrouter-deepseek-deepseek-v4-flash-20260731-nitro`；路由时按注册表把它还原
  回真实的 OpenRouter slug 发给上游，不经过任何思考升档改写。
- 官方配置：`DEEPSEEK_API_KEY`，可用 `DEEPSEEK_ANTHROPIC_BASE_URL` 覆盖 Anthropic
  兼容入口。官方透传原生 Anthropic 请求，不经过 OpenAI schema 转换。
- 两个平台都关闭了本路由的「思考升档」改写，避免 DeepSeek 请求被误改成 Gemini。
- **Windsurf（显式路由）**：请求 `model` 写作 `windsurf-<chat_model_uid>`，例如
  `windsurf-claude-sonnet-5-medium`。该前缀不会被模型重映射或思考升档改写；网关通过
  `agent-ir` 生成 `application/connect+proto` 二进制请求并把响应提升回 Anthropic SSE。
  部署时设置 `WINDSURF_API_KEY`（可选 `WINDSURF_SERVER_URL`）；仅本机开发时可回退读取
  Devin/Windsurf CLI 的凭据文件。此路由不进入 `/v1/models` 自动目录，避免将瞬时账号可用模型
  当作静态承诺发布。

## 模型发现（`GET /v1/models`）

网关只发布「已通过公开目录策略且当前凭据可用」的模型，不把上游旧版、内部或无凭据
模型当作 fallback 广告。响应兼容 OpenAI list 形状，每项额外包含 OMP proxy discovery
需要的 `supported_endpoint_types` / `context_length`，以及网关自有的能力元数据：

- `capabilities.inputModalities`：文本 / 图片；
- `capabilities.tools`：工具定义、调用与结果回放；
- `capabilities.thinking`、`thinkingEfforts`、`canDisableThinking`：推理能力、档位与开关；
- `max_output_tokens` 与 `context_length`：输出和上下文上限；
- `capabilities.protocols`：网关的 Messages / Chat / Responses 三种入口。

OMP 17.2.3 可用下列 provider 配置自动发现，无需手写 `models:` 清单：

```yaml
providers:
  local-gw:
    baseUrl: http://127.0.0.1:8085/v1
    api: anthropic-messages
    auth: none
    disableStrictTools: true
    discovery: { type: proxy }
```

stock OMP 只直接读取发现响应中的 `id/name/supported_endpoint_types/context_length`；图片、
工具、推理档位和输出上限需在 OMP `modelOverrides` 中修正，直到 OMP 扩展 proxy 能力协商。
网关新增/删除模型后执行 `omp models refresh`。

## 运行 / 验收

需要 [Bun](https://bun.sh)。

```bash
bun install
bun run src/server.ts          # 默认 :8085（AGENT_GATEWAY_PORT 可改）
bun run test                   # 仅执行本仓库 test/；避免临时第三方源码被 Bun 递归发现
bun run test:agent             # OMP 三轮目录/文件/图片真实工具门控（需要本机 OMP + Claude OAuth）
bash scripts/run_windsurf_agent_gate.sh  # Windsurf 三轮真实工具门控（本机 Devin/Windsurf 登录态）
```

`test:agent` 会启动隔离 Gateway、使用本机 OMP 登录态完成同一会话中的目录、文件和图片三轮工具
调用，并核验持久化 trace。它要求 `${OMP_SOURCE_AGENT_DIR:-~/.omp/agent}` 中存在 `config.yml` /
`models.yml`，后者包含唯一的 `http://localhost:8085/v1`，且本机 Claude OAuth 可用；因此不放入默认
单元测试命令。

### Windsurf 专项真实 Agent 门控

`bash scripts/run_windsurf_agent_gate.sh` 是 Windsurf Outbox 的独立验收，不会调用 Claude 或
Codex 出口。它启动一个带随机端口和 nonce 的本地 Gateway，用显式
`windsurf-claude-sonnet-5-medium` 模型（可由 `WINDSURF_AGENT_GATE_MODEL_UID` 覆盖，但必须保留
`windsurf-` 前缀），再通过本机已有 `WINDSURF_API_KEY` 或 Devin/Windsurf CLI 登录态请求实际服务。

它在同一个 OMP session、同一个只读临时夹具中依次提问：非隐藏文件数量、按名字排序后的第二个
文件完整内容、图片的主体与可见文字。门控不仅检查三条最终回答，还解析 OMP JSONL trace，要求每轮都
有对应的成功工具调用和结果（目录读取/列举、`02_cobalt.txt`、`06_orange-kite.png`）；因此至少验证三次
真实工具往返，且图片内容必须经工具结果的 image block 传入模型。Windsurf 账号的可用模型是瞬时状态，若默认
UID 不在当前账号目录中，显式选择一个已可用的 UID：

```bash
WINDSURF_AGENT_GATE_MODEL_UID=windsurf-<chat_model_uid> \
  bash scripts/run_windsurf_agent_gate.sh
```

脚本只复制 `${OMP_SOURCE_AGENT_DIR:-~/.omp/agent}` 的配置到 `mktemp`，对运行夹具执行 `chmod a-w`，并在
退出时删除它；Windsurf 模型不会被正式 `/v1/models` 目录静态发布，因此脚本只在该临时 OMP 配置的
`providers.local-gw.models` 中注册它，绝不修改用户的 `models.yml`。设 `KEEP_AGENT_GATE_ARTIFACTS=1`
可保留失败时的隔离 trace 用于排障。先做静态检查：

```bash
bash -n scripts/run_omp_agent_gate.sh scripts/run_windsurf_agent_gate.sh
```

三出口的两轮 `tool_use → tool_result` 实测使用独立终端启动 Gateway 后执行：

```bash
# 终端一
AGENT_GATEWAY_PORT=8103 bun run src/server.ts

# 终端二（Windsurf、Claude、Codex 本地凭据均需可用）
AGENT_GATEWAY_BASE_URL=http://127.0.0.1:8103 bun scripts/real_agent_tool_loop.ts
```

若 cc-relay 的 `/v1/models` 为每个模型给出 `client_protocol`，可让三种入口按模型转换为
对应的真实出站协议（Messages / Chat Completions / Responses）。将仅本机可读的
`~/.config/agent-all-sdk-ts/cc-relay.env` 设为 `0600`，再用 `./start_gateway.sh --restart`：

```bash
ANTHROPIC_BASE_URL=https://<relay>
ANTHROPIC_API_KEY=<client-api-key>
CC_RELAY_PROTOCOL_AWARE=1
```

启动器会显式加载该文件；它不在仓库内，也不会污染 `bun run test`。该模式以 `x-api-key`
读取中转模型目录，并按目录声明出站：`anthropic_messages` → `/v1/messages`，
`openai_chat_completions` → `/v1/chat/completions`，`openai_responses` → `/v1/responses`。
模型名称保持客户端选择的原值；未在目录发布或未声明协议的模型会明确拒绝，不猜测路由。

若后端只有一个 Chat Completions 出口，仍可使用旧的 `FORCE_OPENAI_COMPAT=1` 配置；它只会
发布 Chat 协议模型，不具备上述三协议模型转换能力。

后端按「请求 model id + 本地凭据 + `CLAUDE_CODE_USE_*` 开关」自动选择；DeepSeek 的平台
由 model 前缀决定。凭据来源见 `auth.ts`（`~/.claude/.credentials.json` /
`~/.codex/auth.json` / `~/.gemini/oauth_creds.json` / 各 `*_API_KEY`）。

协议逐项 ground truth 见 [`PROTOCOL_REFERENCE.md`](./PROTOCOL_REFERENCE.md)。
