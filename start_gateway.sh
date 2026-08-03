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
# 经 /v1/chat/completions 进来的客户端若不发 reasoning_effort，就按这个档位开思考。
# jcode 的 openai-compatible provider 就属于这种(它的 openai_reasoning_effort 设置只
# 对原生 openai 档生效)，不给默认值的话它永远拿不到思考预算，"调推理等级"是死的。
# 想改档位: AGENT_GATEWAY_DEFAULT_EFFORT=medium ./start_gateway.sh --restart
# 可选值 none|minimal|low|medium|high|xhigh|max，none 表示不开思考。
export AGENT_GATEWAY_DEFAULT_EFFORT="${AGENT_GATEWAY_DEFAULT_EFFORT:-high}"
LOG="${GATEWAY_LOG:-$HOME/.local/state/agent-all-sdk-ts/gateway.log}"
mkdir -p "$(dirname -- "$LOG")"

port_live() { timeout 2 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; }

# 谁在监听 $PORT。必须按端口找，不能按命令行找：
# 原来 --restart 用的是 pkill -f "bun run src/server.ts"，而端口是环境变量传的、
# 不出现在命令行里,于是同一份源码起的**所有**实例都会被打死 —— 实测
# `AGENT_GATEWAY_PORT=8086 ./start_gateway.sh --restart` 把生产的 :8085 一起端了。
port_pid() {
  ss -ltnpH "sport = :${PORT}" 2>/dev/null \
    | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

if [[ "${1:-}" == "--restart" ]]; then
  restart_pid="$(port_pid)"
  if [[ -n "$restart_pid" ]]; then
    echo "[restart] 终结 :${PORT} 上的实例 (pid ${restart_pid})"
    kill "$restart_pid" 2>/dev/null || true
    for _ in {1..15}; do port_live || break; sleep 0.5; done
    # 还赖着不走就升级为 SIGKILL，仍然只针对这一个 pid
    if port_live; then kill -9 "$restart_pid" 2>/dev/null || true; sleep 1; fi
  else
    echo "[restart] :${PORT} 上没有实例在跑，直接起"
  fi
elif port_live; then
  echo "[ok] :${PORT} 已在监听 (pid $(port_pid))"
  exit 0
fi

PROXY_UNSET=(-u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy
             -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy)
# DeepSeek 的两个平台必须同时注入，模型目录才会同时发布：
#   official/deepseek-* -> DEEPSEEK_API_KEY -> api.deepseek.com
#   bailian/deepseek-*  -> DASHSCOPE_API_KEY -> DashScope
# 允许显式环境变量覆盖；未设置时从本机 600 权限密钥文件加载。
DEEPSEEK_KEY_FILE="${DEEPSEEK_KEY_FILE:-$HOME/.config/omp/deepseek.key}"
DASHSCOPE_KEY_FILE="${DASHSCOPE_KEY_FILE:-$HOME/.config/omp/dashscope.key}"
if [[ -z "${DEEPSEEK_API_KEY:-}" && -r "$DEEPSEEK_KEY_FILE" ]]; then
  export DEEPSEEK_API_KEY="$(<"$DEEPSEEK_KEY_FILE")"
fi
if [[ -z "${DASHSCOPE_API_KEY:-}" && -r "$DASHSCOPE_KEY_FILE" ]]; then
  export DASHSCOPE_API_KEY="$(<"$DASHSCOPE_KEY_FILE")"
fi

# 调用方显式传了 OPENAI_API_KEY 就尊重它, 否则清掉(见上文 why 2)
KEY_UNSET=()
[[ -z "${OPENAI_API_KEY_EXPLICIT:-}" ]] && KEY_UNSET=(-u OPENAI_API_KEY)

# 显式下发端口: 脚本管的是 $PORT 这一个实例，子进程必须绑同一个端口，不能靠调用方
# 环境里碰巧有没有 AGENT_GATEWAY_PORT。
export AGENT_GATEWAY_PORT="$PORT"

env "${PROXY_UNSET[@]}" "${KEY_UNSET[@]}" \
    setsid nohup bun run src/server.ts >>"$LOG" 2>&1 &

for _ in {1..20}; do
  if port_live; then
    # pid 也按端口查。原来用 pgrep|head -1 在多实例下会报**别的**实例的 pid，
    # 上一次就是被这条误导才没发现 --restart 把另一个实例打死了。
    echo "[ok] :${PORT} 已起 (pid $(port_pid))  log=$LOG"
    exit 0
  fi
  sleep 0.5
done

echo "[fail] :${PORT} 未起来，最后 20 行日志:" >&2
tail -20 "$LOG" >&2
exit 1
