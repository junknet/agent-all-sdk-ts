# agent-all-sdk-ts

多厂商 LLM 协议网关（TypeScript / Bun）。前端同时讲 **Anthropic Messages / OpenAI Chat
Completions / OpenAI Responses** 三套协议，后端把请求路由到 **Claude / Codex(ChatGPT) /
Gemini** 各家，用 **Anthropic 格式作为统一中间表示（canonical IR）**双向翻译流式报文——含工具
调用、思考/reasoning、图片，并逐项修正各家 wire 的脏细节。

> 这是**完整私有版**（含 Claude 出口 + gemini 评测路由逻辑）。对外脱敏精简版见
> [`llm-wire-gateway`](https://github.com/junknet/llm-wire-gateway)（出口仅 GPT/Gemini，去敏感）。

## 架构：单 IR + 多后端（LLVM 模型）

```
  入口协议 (ingress)            统一 IR             出口后端 (egress)
  ├ POST /v1/messages   ┐                    ┌ anthropic-passthrough (Claude)
  ├ POST /v1/chat/...   ┼─ decode ─► Anthropic ─ encode ─┼ codex (ChatGPT Responses)
  └ POST /v1/responses  ┘          canonical          ├ openai-compat (OpenAI/Gemini-OAI)
                                                       └ antigravity (Gemini CloudCode)
```

- IR = Anthropic Messages 格式（注释里称 `Anthropic-canonical`）。
- 后端契约 = `WireProvider`：`buildRequest`（IR→厂商 wire，= lower）+ `parseStream`（厂商 SSE→IR，= lift）。
- `createWireAdapter` 串起整条管线（解码→压图→选 provider→重试→回流 IR SSE）。

## 目录树（单向递降，facade 先行）

```
src/
├ index.ts        ── facade：pickWireProvider 选后端 · createWireAdapter 管线 · resolveModel/latestUserInput 路由
├ server.ts       ── 入口：Bun.serve，三协议 HTTP 端点 → index.ts
├ types.ts        ── L0 IR 类型契约（AnthropicMessagesRequest / WireProvider / …）
├ emitter.ts      ── Anthropic SSE 事件发射器（各 provider lift 的目标）
├ sse.ts          ── SSE 解析原语（iterSSE / tryParseJSON）
├ auth.ts         ── 本地凭据探测 + OAuth 刷新（Claude / Codex Source）
├ devlog.ts       ── 全量流量 NDJSON 落盘（trace 串联各阶段）
├ image_compress.ts ── 入站图片自动压缩（magick，可选）
├ passthrough.ts  ── 非 /v1/messages 请求直透判定
├ responses_api.ts ── OpenAI Responses ⇄ canonical 编解码（codex 入口用）
└ providers/      ── L2 后端实现，各自一家厂商 wire
   ├ antigravity_provider.ts        ── Gemini via Google CloudCode
   ├ codex_provider.ts              ── ChatGPT Codex Responses
   ├ openai_compat_provider.ts      ── OpenAI Chat Completions / Gemini-OAI
   └ anthropic_passthrough_provider.ts ── Claude（OAuth / API key 直透）
```

**import 方向（单向，无环）**：`types` ← 所有；`emitter/sse/auth` ← `providers`；
`providers/emitter/passthrough/devlog/image_compress/auth` ← `index`；
`index/sse/responses_api/providers/auth/devlog` ← `server`。同层不横向 import。

## 网关侧路由逻辑（本版特有，`index.ts`）

- **模型重映射** `MODEL_REMAP`：客户端的 haiku 类背景模型 → 最便宜的 gemini 挡，省钱且不污染 gemini 评测。
- **「思考」升档** `resolveModel` + `latestUserInput`：用户**最近一次输入**含「思考/深思/think hard/
  ultrathink」时，把当次 flash 低挡升到高挡（`gemini-3-flash-agent`），且**只罩这一轮 agent loop**——
  下次普通输入即回落（状态机，非历史粘滞；tool_result 不算人类输入）。Pro 挡永不被升档拉低。
- **Gemini thoughtSignature 缓存**（`antigravity_provider.ts`）：Gemini 多轮推理依赖每个 functionCall 的
  `thoughtSignature`，但它无法穿过 codex/openai 往返。网关按 `call_id` 服务端缓存真签名、replay 时贴回，
  替掉 `skip_thought_signature_validator` 占位——否则跨轮推理链断裂会导致重复规划 / MALFORMED / 400。

## 运行 / 验收

需要 [Bun](https://bun.sh)。

```bash
bun install
bun run src/server.ts          # 默认 :8085（AGENT_GATEWAY_PORT 可改）
bun test                       # wire 契约 + 升档状态机 + 签名 lockstep + E2E（有凭据才跑对应后端）
```

后端按「请求 model id + 本地凭据 + `CLAUDE_CODE_USE_*` 开关」自动选择；凭据来源见 `auth.ts`
（`~/.claude/.credentials.json` / `~/.codex/auth.json` / `~/.gemini/oauth_creds.json` / 各 `*_API_KEY`）。

协议逐项 ground truth 见 [`PROTOCOL_REFERENCE.md`](./PROTOCOL_REFERENCE.md)。
