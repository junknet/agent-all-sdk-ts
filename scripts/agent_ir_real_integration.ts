/**
 * agent-ir lib 的真实集成测试 —— 不 mock,不 stub。
 *
 * 链路:agent-ir 的 IR 决策链(lib)→ 本地真实网关(agent-all-sdk-ts :8099)
 * → 真实上游(cc-relay / deepseek)。
 *
 * 把本地网关当上游,是为了:
 *  1. agent-ir 的 anthropic 出口 lower 出真实 wire 请求(URL/headers/body)
 *  2. 真实 fetch 到 :8099(它自己有真实凭据)
 *  3. :8099 再转发到真实上游,回真实 SSE
 *  4. agent-ir 的 readUpstreamResponse 把真实 SSE lift 成 IREvent
 *  5. writeClientResponse 编码回客户端
 *
 * 全程不 stub Response,不 mock fetch —— 每一条 IREvent 都来自真实上游的字节。
 */
import { createAnthropicUpstream } from "agent-ir";
import { readAnthropicMessagesRequest } from "agent-ir";
import { checkUpstreamSupport } from "agent-ir";
import { INGRESS_CODECS } from "agent-ir";
import type { IREvent } from "agent-ir";

const GATEWAY = "http://127.0.0.1:8099";

// 1. 真实客户端请求体(Claude Code 会发的形状)
const rawBody = {
  model: "ccr-claude-haiku-4-5",
  max_tokens: 256,
  stream: true,
  messages: [{ role: "user", content: "Reply with exactly: AGENT-IR-LIB-REAL-OK" }],
};

async function main() {
  // 2. ingress decode:真实请求体 → IR(agent-ir lib)
  const { request } = INGRESS_CODECS["anthropic_messages"].readClientRequest(rawBody, "real-integration");
  console.log("[1] IR decoded:", JSON.stringify({
    model: request.model,
    turns: request.conversation.turns.length,
    requires: request.requires.map((r) => r.capability),
  }));

  // 3. egress:anthropic 出口,打本地网关
  const egress = createAnthropicUpstream({
    baseUrl: GATEWAY,
    apiKey: "local-gateway",
    model: request.model,
  });

  // 4. admission:检查出口能不能承载
  const verdict = checkUpstreamSupport(request, egress.profile);
  console.log("[2] admission:", JSON.stringify({ admitted: verdict.admitted, losses: verdict.losses.length }));

  // 5. lower:IR → 真实 wire
  const lowered = await egress.writeUpstreamRequest(request);
  if (!lowered.ok) throw new Error(`lower refused: ${JSON.stringify(lowered.problems)}`);
  console.log("[3] wire:", JSON.stringify({ url: lowered.wire.url, method: lowered.wire.method, bodyBytes: lowered.wire.body.length }));

  // 6. 真实 fetch 到本地网关(它再转真实上游)
  const upstream = await fetch(lowered.wire.url, {
    method: lowered.wire.method,
    headers: lowered.wire.headers,
    body: lowered.wire.body,
  });
  console.log("[4] upstream status:", upstream.status);

  // 7. lift:真实 SSE → IREvent 流
  const events: IREvent[] = [];
  for await (const event of egress.readUpstreamResponse(upstream)) {
    events.push(event);
  }
  const kinds = events.map((e) => e.kind);
  console.log("[5] events:", JSON.stringify(kinds));
  const texts = events
    .filter((e): e is Extract<IREvent, { kind: "partDelta" }> => e.kind === "partDelta")
    .map((e) => (e.delta.kind === "text" ? e.delta.text : `<${e.delta.kind}>`));
  console.log("[5b] partDelta texts:", JSON.stringify(texts));

  // 8. writeClientResponse:编码回 Anthropic SSE(流式,必须用 reader 读完)
  const clientResponse = await INGRESS_CODECS["anthropic_messages"].writeClientResponse(
    (async function* () {
      for (const e of events) yield e;
    })(),
    request,
    { messageId: "msg_real_integration" },
  );
  const reader = clientResponse.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let chunkCount = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunkCount += 1;
        text += decoder.decode(value, { stream: true });
      }
    }
  }
  console.log("[6] chunkCount:", chunkCount, "textLength:", text.length);
  console.log("[6] client SSE (first 500):", text.slice(0, 500));

  // 内容分帧到达(两个 text_delta 帧),SSE 帧间有 \n\n 边界,不能要求连写。
  const hasContent = text.includes("AGENT-IR-LIB-") && text.includes("REAL-OK");
  console.log(hasContent ? "PASS: real content reached the client" : "FAIL: no content in client response");
  if (!hasContent) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
