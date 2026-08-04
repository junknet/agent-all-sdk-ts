/**
 * agent-ir lib 的真实流式集成测试 —— 不 mock,不 stub,不预收集。
 *
 * 与 agent_ir_real_integration.ts 的区别:这里把 readUpstreamResponse 的
 * AsyncIterable **直接**喂给 writeClientResponse,让编码器边收边发,
 * 完整经过真实的 SSE 流(本地网关 → 真实 cc-relay 上游)。
 *
 * 这条路径是网关的常态:不是先攒完再回放,而是每个上游帧即时编码出站。
 */
import { createAnthropicUpstream } from "agent-ir";
import { checkUpstreamSupport } from "agent-ir";
import { INGRESS_CODECS } from "agent-ir";

const GATEWAY = "http://127.0.0.1:8099";

const rawBody = {
  model: "ccr-claude-haiku-4-5",
  max_tokens: 256,
  stream: true,
  messages: [{ role: "user", content: "Reply with exactly: IR-REAL-STREAM-OK" }],
};

async function main() {
  const { request } = INGRESS_CODECS["anthropic_messages"].readClientRequest(rawBody, "real-stream");
  const egress = createAnthropicUpstream({
    baseUrl: GATEWAY,
    apiKey: "local-gateway",
    model: request.model,
  });

  const verdict = checkUpstreamSupport(request, egress.profile);
  console.log("[1] admission:", JSON.stringify({ admitted: verdict.admitted }));

  const lowered = await egress.writeUpstreamRequest(request);
  if (!lowered.ok) throw new Error(`lower refused: ${JSON.stringify(lowered.problems)}`);

  const upstream = await fetch(lowered.wire.url, {
    method: lowered.wire.method,
    headers: lowered.wire.headers,
    body: lowered.wire.body,
  });
  console.log("[2] upstream status:", upstream.status);

  // 直通:lift 流直接进 encode,不收集。
  const clientResponse = await INGRESS_CODECS["anthropic_messages"].writeClientResponse(
    egress.readUpstreamResponse(upstream),
    request,
    { messageId: "msg_real_stream" },
  );

  const reader = clientResponse.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }

  console.log("[3] client SSE length:", text.length);
  // 打印全部帧的 data 行(不打印 event: 行),看内容帧到底到没到
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
  console.log("[3] data frames:", dataLines.length);
  for (const l of dataLines) console.log("   ", l.slice(0, 200));
  // 内容分帧到达(两个 text_delta 帧):"IR" + "-REAL-STREAM-OK",SSE 帧间有边界。
  const ok = text.includes('"text":"IR"') && text.includes('"-REAL-STREAM-OK"');
  console.log(ok ? "PASS: real stream reached the client" : "FAIL: stream did not carry content");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
