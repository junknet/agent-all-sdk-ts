#!/usr/bin/env bash
# Real Windsurf agent gate: the shared OMP verifier proves the three turns and
# persisted tool results; this entry point makes the selected Outbox explicit.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
windsurf_model_uid="${WINDSURF_AGENT_GATE_MODEL_UID:-windsurf-claude-sonnet-5-medium}"

[[ "$windsurf_model_uid" =~ ^windsurf-[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "WINDSURF_AGENT_GATE_MODEL_UID must use the windsurf- prefix: $windsurf_model_uid" >&2
  exit 2
}

# The gateway takes WINDSURF_API_KEY first and otherwise uses the existing
# local Devin/Windsurf CLI login.  The explicit prefix reaches no other Outbox.
exec env \
  AGENT_GATE_NAME="Windsurf-OMP" \
  AGENT_GATE_MODEL_UID="$windsurf_model_uid" \
  AGENT_GATE_EXPECTED_OMP_MODEL="local-gw/${windsurf_model_uid}" \
  AGENT_GATE_EXPECTED_MODEL_UID="$windsurf_model_uid" \
  AGENT_GATE_REGISTER_STATIC_MODEL=1 \
  AGENT_GATE_THINKING_EFFORTS=medium \
  AGENT_GATE_DEFAULT_THINKING_EFFORT=medium \
  AGENT_GATE_CONTEXT_WINDOW=1000000 \
  AGENT_GATE_MAX_TOKENS=128000 \
  bash "$project_dir/scripts/run_omp_agent_gate.sh"
