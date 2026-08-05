# Codex WebSocket 交接

## 当前状态

`local-gpt-*` 已不再向 ChatGPT Codex 使用 HTTP POST。唯一响应路径是：

```text
OMP TUI → gateway → Codex WebSocket JSON 帧 → agent-ir 事件读取 → 流守卫 → Anthropic Inbox SSE
```

应用层只持有 OAuth、账户头、WebSocket 连接和 Pino 观察；协议帧编译、读取、会话续接与 Inbox 编码归 `agent-ir`。

首个要检查的入口是 [src/providers/codex_responses_outbox.ts](src/providers/codex_responses_outbox.ts)。实际连接实现是 [src/providers/codex_websocket_transport.ts](src/providers/codex_websocket_transport.ts)。

## 已证实的问题

账号在本机 Codex 中具备 Fast 权益，但网关的真实 WebSocket 请求虽然发送 `service_tier: "priority"`，服务端 `response.created` 仍回显 `service_tier: "auto"`。

这不是 HTTP 旧通道、响应解析或 Inbox 编码导致：真实 tmux 内 OMP TUI 已完成多次正常请求，且 Pino 记录了完整的 `messageStart`、文本分片、usage、`messageStop:endTurn` 与无错误完成。

当前最小差异是证明头：本机 Codex 源码在启用证明提供者时，为 WebSocket 握手加入 `x-oai-attestation`；网关的 Pino 已脱敏记录的实际头名不含该字段。该值必须通过本机 Codex App Server 的 `attestation/generate` 请求即时取得，不能从 OAuth token 推导、缓存或伪造。

尚未完成的目标是把这个原生 attestation 生成通道接入网关，并再次以服务端回显确认 `priority`。

## 已完成的兼容修正

- 使用 `OpenAI-Beta: responses_websockets=2026-02-06`。
- 使用 `response.create` WebSocket 帧，默认写入 `service_tier: "priority"`。
- `additional_tools` 的首项 role 使用服务端当前要求的 `developer`。
- WebSocket JSON 的物理多行按 SSE 规则逐行加 `data:` 前缀；否则会形成不完整 JSON 并触发客户端重试。
- WebSocket 显式 `error`、`response.failed`、`response.incomplete` 与 `response.completed` 都是终止事件，避免再附加伪造的传输错误。

## 真实验证方式

不要用 `-p`、curl 或模拟响应判断结果。必须使用真实 OMP TUI，并同时观察 Pino 落盘日志。

1. 编译、测试并重启网关：

   ```bash
   cd ../agent-ir && bun run typecheck && bun run test
   cd . && bunx tsc --noEmit && bun run test
   supervisorctl restart vlm_gateway
   ```

2. 在 tmux 中打开 OMP 的交互 TUI。模型状态栏必须显示 `local-gpt-5.6-terra` 与 `local-gw`；例如已存在的验证会话可直接进入：

   ```bash
   tmux attach -t <session>
   ```

3. 在 TUI 中输入一个无工具的确定性提示，例如“只回复严格文本：WS_FINAL_OK。不要调用工具。”。等待终端实际显示该文本；不能以命令退出码替代此检查。

4. 查看 Pino 文件，不输出或复制任何脱敏前请求：

   ```bash
   rg 'outbox.request_compiled|outbox.response_streaming|agent_ir.outbox_sse_scheduling|agent_ir.inbox_response_completed' \
     <log-dir>/vlm_gateway.err.log | tail -n 40
   ```

5. 判定通过需要同一 trace 内同时出现：

   - `url: wss://chatgpt.com/backend-api/codex/responses`
   - 出站 `scheduling.serviceTier: "priority"`
   - `transport: "websocket"`
   - `agent_ir.inbox_response_completed` 且 `error: null`、`stopReason: "endTurn"`

6. 只有服务端 `agent_ir.outbox_sse_scheduling.scheduling.serviceTier` 也回显 `priority`，才能判定 Fast 实际授予。当前已验证该字段仍为 `auto`，因此不得把“请求字段已发送”误报为“Fast 已生效”。

## 排障分支

| 现象 | 判定 | 下一步 |
| --- | --- | --- |
| TUI 返回错误且日志有 `invalidRequest` | Codex wire 契约变化 | 以服务端错误字段更新 `agent-ir/src/outbox/codex/index.ts`，补回归测试。 |
| `response.created` 前出现未解析帧 | WebSocket→SSE 封装错误 | 检查完整帧是否每一物理行都带 `data:` 前缀。 |
| TUI 成功、完成事件无错误、回显仍为 `auto` | 请求未获得 Fast 调度 | 对接本机 Codex App Server 的 `attestation/generate`，不可伪造证明头。 |
| 回显为 `priority` 但仍慢 | 已不是网关字段或协议问题 | 用服务端 timing 事件与同账号原生 Codex TUI 做同提示对比。 |

## 关键文件

- 应用 WebSocket 装配：[src/providers/codex_responses_outbox.ts](src/providers/codex_responses_outbox.ts)
- 应用连接层：[src/providers/codex_websocket_transport.ts](src/providers/codex_websocket_transport.ts)
- 应用入口分流：[src/index.ts](src/index.ts)
- Codex 帧编译与读取：`../agent-ir/src/outbox/codex/index.ts`
- 事件到 Inbox 的单一路径：`../agent-ir/src/ir/outbox_response_to_inbox.ts`
