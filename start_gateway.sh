#!/usr/bin/env bash
# 拉起 agent-all-sdk-ts 网关。幂等: 已在监听就跳过, 加 --restart 强制重启。
#
# why-not-what:
# 1) 清掉 *_PROXY。上游 (api.anthropic.com / googleapis.com / chatgpt.com)
#    直连可达, 而继承来的 http://127.0.0.1:7897 (Clash) 一旦没起, 网关每条
#    出口都会报 "Unable to connect", 且错误信息不指向代理, 极难定位。
# 2) 清掉 OPENAI_API_KEY。auth.ts detectLocalCredits 的 codex 分支是 else-if
#    链: env api_key 命中后就不再读 ~/.codex/auth.json, 而 index.ts 只接受
#    type==='oauth' 的 codex credit —— 于是一个失效的 env key 会静默把整条
#    ChatGPT 订阅出口挡掉, 请求改落 openai-compat 并 401。要用真 OpenAI key
#    时显式 OPENAI_API_KEY=xxx ./start_gateway.sh --restart 覆盖。
set -euo pipefail

cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

PORT="${AGENT_GATEWAY_PORT:-8085}"
LOG="${GATEWAY_LOG:-$HOME/.local/state/agent-all-sdk-ts/gateway.log}"
mkdir -p "$(dirname -- "$LOG")"

port_live() { timeout 2 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; }

if [[ "${1:-}" == "--restart" ]]; then
  pkill -f "bun run src/server.ts" 2>/dev/null || true
  for _ in {1..15}; do port_live || break; sleep 0.5; done
elif port_live; then
  echo "[ok] :${PORT} 已在监听 (pid $(pgrep -f 'bun run src/server.ts' | head -1))"
  exit 0
fi

PROXY_UNSET=(-u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy
             -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy)
# 调用方显式传了 OPENAI_API_KEY 就尊重它, 否则清掉(见上文 why 2)
KEY_UNSET=()
[[ -z "${OPENAI_API_KEY_EXPLICIT:-}" ]] && KEY_UNSET=(-u OPENAI_API_KEY)

env "${PROXY_UNSET[@]}" "${KEY_UNSET[@]}" \
    setsid nohup bun run src/server.ts >>"$LOG" 2>&1 &

for _ in {1..20}; do
  if port_live; then
    echo "[ok] :${PORT} 已起 (pid $(pgrep -f 'bun run src/server.ts' | head -1))  log=$LOG"
    exit 0
  fi
  sleep 0.5
done

echo "[fail] :${PORT} 未起来，最后 20 行日志:" >&2
tail -20 "$LOG" >&2
exit 1
