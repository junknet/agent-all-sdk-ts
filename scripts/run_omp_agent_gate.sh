#!/usr/bin/env bash
# Real OMP agent gate: three user turns across one session, with file and image tools.
# Every turn exposes only glob/read/inspect_image.  The fixture is copied to a
# temporary read-only directory, so --auto-approve cannot mutate the repository.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$project_dir/test/fixtures/agent_gate"
port="${AGENT_GATEWAY_PORT:-$((20000 + RANDOM % 30000))}"
base_url="http://127.0.0.1:${port}"
omp_source_dir="${OMP_SOURCE_AGENT_DIR:-$HOME/.omp/agent}"
agent_gateway_model_uid="${AGENT_GATE_MODEL_UID:-local-claude-sonnet-5}"
agent_gate_name="${AGENT_GATE_NAME:-OMP}"
agent_gate_expected_omp_model="${AGENT_GATE_EXPECTED_OMP_MODEL:-local-gw/${agent_gateway_model_uid}}"
agent_gate_expected_model_uid="${AGENT_GATE_EXPECTED_MODEL_UID:-${agent_gateway_model_uid}}"
agent_gate_register_static_model="${AGENT_GATE_REGISTER_STATIC_MODEL:-0}"
agent_gate_thinking_efforts="${AGENT_GATE_THINKING_EFFORTS:-high}"
agent_gate_default_thinking_effort="${AGENT_GATE_DEFAULT_THINKING_EFFORT:-high}"
agent_gate_context_window="${AGENT_GATE_CONTEXT_WINDOW:-200000}"
agent_gate_max_tokens="${AGENT_GATE_MAX_TOKENS:-16384}"
omp_test_dir="$(mktemp -d)"
session_dir="$omp_test_dir/sessions"
runtime_fixture_dir="$omp_test_dir/fixture"
gateway_log="$(mktemp)"
gateway_pid=""
gateway_ready_nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"

first_prompt='Use tools. Count the non-hidden files directly in the current directory. Reply only: COUNT=<number>.'
second_prompt='Use tools. Sort the non-hidden file names in the current directory lexicographically, read the second file, then reply with its complete content and nothing else.'
third_prompt='Use an available image-capable tool on the path 06_orange-kite.png. Reply only with: IMAGE=<subject>; TEXT=<visible text>.'
response_format_constraint='This is an automated gate. Follow the user requested response format exactly; do not append a sign-off, emoji, punctuation, markdown, or commentary.'

readonly -a omp_common_args=(
  --cwd "$runtime_fixture_dir"
  --session-dir "$session_dir"
  --model "local-gw/${agent_gateway_model_uid}"
  --tools glob,read,inspect_image
  --no-extensions
  --no-skills
  --no-rules
  --no-pty
  --auto-approve
  --max-time 90
  --append-system-prompt "$response_format_constraint"
)

cleanup() {
  if [[ -n "$gateway_pid" ]] && kill -0 "$gateway_pid" 2>/dev/null; then kill "$gateway_pid"; wait "$gateway_pid" 2>/dev/null || true; fi
  if [[ "${KEEP_AGENT_GATE_ARTIFACTS:-0}" == "1" ]]; then
    echo "kept OMP gate artifacts: $omp_test_dir" >&2
    return
  fi
  # The fixture is deliberately read-only during the test; restore ownership
  # write permission only inside this mktemp-created directory before cleanup.
  chmod -R u+w "$omp_test_dir" 2>/dev/null || true
  rm -rf "$omp_test_dir"
  rm -f "$gateway_log"
}
trap cleanup EXIT

[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "invalid gateway port: $port" >&2; exit 2; }
[[ "$gateway_ready_nonce" =~ ^[0-9a-f]{32}$ ]] || { echo 'failed to generate gateway readiness nonce' >&2; exit 2; }
[[ "$agent_gateway_model_uid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "invalid AGENT_GATE_MODEL_UID: $agent_gateway_model_uid" >&2
  exit 2
}
[[ "$agent_gate_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "invalid AGENT_GATE_NAME: $agent_gate_name" >&2
  exit 2
}
[[ "$agent_gate_register_static_model" =~ ^[01]$ ]] || {
  echo "AGENT_GATE_REGISTER_STATIC_MODEL must be 0 or 1" >&2
  exit 2
}
[[ "$agent_gate_thinking_efforts" =~ ^[a-z]+(,[a-z]+)*$ ]] || {
  echo "AGENT_GATE_THINKING_EFFORTS must be a comma-separated effort list" >&2
  exit 2
}
[[ "$agent_gate_default_thinking_effort" =~ ^[a-z]+$ ]] || {
  echo "AGENT_GATE_DEFAULT_THINKING_EFFORT must be an effort name" >&2
  exit 2
}
[[ "$agent_gate_context_window" =~ ^[1-9][0-9]*$ ]] || {
  echo "AGENT_GATE_CONTEXT_WINDOW must be a positive integer" >&2
  exit 2
}
[[ "$agent_gate_max_tokens" =~ ^[1-9][0-9]*$ ]] || {
  echo "AGENT_GATE_MAX_TOKENS must be a positive integer" >&2
  exit 2
}

for required in "$omp_source_dir/config.yml" "$omp_source_dir/models.yml"; do
  [[ -f "$required" ]] || { echo "OMP config missing: $required" >&2; exit 2; }
done
cp "$omp_source_dir/config.yml" "$omp_test_dir/config.yml"
cp "$omp_source_dir/models.yml" "$omp_test_dir/models.yml"
cp -R "$fixture_dir" "$runtime_fixture_dir"
chmod -R a-w "$runtime_fixture_dir"
[[ -z "$(find "$runtime_fixture_dir" -perm /222 -print -quit)" ]] || { echo 'runtime fixture must be read-only' >&2; exit 2; }
# Isolate OMP state, but point its generated local-gw provider at this gate instance.
mapfile -t local_gateway_urls < <(rg -o -F 'http://localhost:8085/v1' "$omp_test_dir/models.yml" || true)
[[ "${#local_gateway_urls[@]}" == 1 ]] || {
  echo "expected exactly one local-gw base URL in OMP models.yml, found ${#local_gateway_urls[@]}" >&2
  exit 2
}
sed -i "s|http://localhost:8085/v1|${base_url}/v1|g" "$omp_test_dir/models.yml"
rg -F -q "${base_url}/v1" "$omp_test_dir/models.yml" || {
  echo 'failed to point isolated OMP configuration at this gateway' >&2
  exit 2
}

# OMP modelOverrides only alter models returned by discovery; they cannot add
# a new one.  Some provider-specific gates deliberately select a model that
# production discovery does not advertise, so register it through OMP's native
# providers.<name>.models configuration in the test-local copy only.
if [[ "$agent_gate_register_static_model" == '1' ]]; then
  sed -i "/^    modelOverrides:$/i\\
    models:\\
      - id: ${agent_gateway_model_uid}\\
        name: ${agent_gateway_model_uid}\\
        reasoning: true\\
        thinking: { mode: anthropic-budget-effort, efforts: [${agent_gate_thinking_efforts//,/ }], defaultLevel: ${agent_gate_default_thinking_effort}, supportsDisplay: true }\\
        input: [text, image]\\
        supportsTools: true\\
        contextWindow: ${agent_gate_context_window}\\
        maxTokens: ${agent_gate_max_tokens}" "$omp_test_dir/models.yml"
fi

# Keep capability metadata explicit in the isolated model override.  This is
# harmless for a static definition and required for a discovered one.
if ! rg -q "^      ${agent_gateway_model_uid}:$" "$omp_test_dir/models.yml"; then
  sed -i "/^    modelOverrides:$/a\\
      ${agent_gateway_model_uid}:\\
        name: ${agent_gateway_model_uid}\\
        reasoning: true\\
        thinking: { mode: anthropic-budget-effort, efforts: [${agent_gate_thinking_efforts//,/ }], defaultLevel: ${agent_gate_default_thinking_effort}, supportsDisplay: true }\\
        input: [text, image]\\
        supportsTools: true\\
        contextWindow: ${agent_gate_context_window}\\
        maxTokens: ${agent_gate_max_tokens}" "$omp_test_dir/models.yml"
fi
rg -q "^      ${agent_gateway_model_uid}:$" "$omp_test_dir/models.yml" || {
  echo "failed to register isolated OMP model: ${agent_gateway_model_uid}" >&2
  exit 2
}
if [[ "$agent_gate_register_static_model" == '1' ]]; then
  rg -q "^      - id: ${agent_gateway_model_uid}$" "$omp_test_dir/models.yml" || {
    echo "failed to add isolated static OMP model: ${agent_gateway_model_uid}" >&2
    exit 2
  }
fi

(cd "$project_dir" && AGENT_GATEWAY_PORT="$port" AGENT_GATEWAY_READY_NONCE="$gateway_ready_nonce" bun run src/server.ts >"$gateway_log" 2>&1) &
gateway_pid=$!

gateway_is_ready() {
  local response status body
  response="$(curl -sS --connect-timeout 1 --max-time 1 -w $'\n%{http_code}' "${base_url}/__agent_gate_ready" 2>/dev/null || true)"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [[ "$status" == '200' && "$body" == "$gateway_ready_nonce" ]]
}

for _ in $(seq 1 50); do
  # /v1/models may wait on provider discovery.  The nonce ties this local-only
  # route to the process started above, preventing a stale process on this port
  # from making the gate pass.
  if gateway_is_ready; then break; fi
  sleep 0.1
done
gateway_is_ready || { cat "$gateway_log" >&2; exit 1; }

run_turn() {
  PI_CODING_AGENT_DIR="$omp_test_dir" omp \
    "${omp_common_args[@]}" \
    "$@"
}

trim_gate_answer() {
  local answer="$1"
  answer="${answer%"${answer##*[![:space:]]}"}"
  # ~/.omp/agent/AGENTS.md mandates exactly this final sign-off.  It is an
  # OMP-owned global instruction, so permit one optional instance only.
  if [[ "$answer" == *$'\n喵' ]]; then
    answer="${answer%$'\n喵'}"
    answer="${answer%"${answer##*[![:space:]]}"}"
  fi
  printf '%s' "$answer"
}

first_raw="$(run_turn --print "$first_prompt")"
first="$(trim_gate_answer "$first_raw")"
[[ "$first" == 'COUNT=6' ]] || { echo "gate turn 1 failed: expected COUNT=6, got: $first_raw" >&2; exit 1; }

second_raw="$(run_turn --continue --print "$second_prompt")"
second="$(trim_gate_answer "$second_raw")"
[[ "$second" == 'SECOND-FILE-CONTENT: cobalt is the second fixture.' ]] || { echo "gate turn 2 failed: expected complete fixture content, got: $second_raw" >&2; exit 1; }

third_raw="$(run_turn --continue --print "$third_prompt")"
third="$(trim_gate_answer "$third_raw")"
[[ "$third" =~ ^IMAGE=.+\;[[:space:]]TEXT=ORANGE[[:space:]]KITE$ ]] && [[ "$third" =~ [Oo]range ]] && [[ "$third" =~ [Kk]ite ]] || { echo "gate turn 3 failed: expected orange kite and exact visible text, got: $third_raw" >&2; exit 1; }

# Semantic answers alone are insufficient: parse the persisted JSONL and prove
# that every turn used the permitted tool path and received its required result.
mapfile -t session_files < <(find "$session_dir" -type f -name '*.jsonl' -print)
[[ "${#session_files[@]}" == 1 ]] || { echo "expected one OMP session trace, found ${#session_files[@]}" >&2; exit 1; }
session_file="${session_files[0]}"
AGENT_GATE_EXPECTED_OMP_MODEL="$agent_gate_expected_omp_model" \
AGENT_GATE_EXPECTED_MODEL_UID="$agent_gate_expected_model_uid" \
bun -e '
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [sessionFile, fixtureDirectory] = process.argv.slice(-2);
const expected = {
  model: process.env.AGENT_GATE_EXPECTED_OMP_MODEL,
  modelUid: process.env.AGENT_GATE_EXPECTED_MODEL_UID,
  provider: "local-gw",
  firstPrompt: "Use tools. Count the non-hidden files directly in the current directory. Reply only: COUNT=<number>.",
  secondPrompt: "Use tools. Sort the non-hidden file names in the current directory lexicographically, read the second file, then reply with its complete content and nothing else.",
  thirdPrompt: "Use an available image-capable tool on the path 06_orange-kite.png. Reply only with: IMAGE=<subject>; TEXT=<visible text>.",
  secondFileContent: "SECOND-FILE-CONTENT: cobalt is the second fixture.",
};

expect(typeof expected.model === "string" && expected.model.length > 0, "expected OMP model was not configured");
expect(typeof expected.modelUid === "string" && expected.modelUid.length > 0, "expected model uid was not configured");

function fail(message) {
  throw new Error(`OMP trace verification failed: ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

const records = readFileSync(sessionFile, "utf8")
  .trimEnd()
  .split("\n")
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`line ${index + 1} is not JSON`);
    }
  });
const fixturePath = resolve(fixtureDirectory);
const session = records.find((record) => record.type === "session");
expect(session?.cwd === fixturePath, `session cwd was not the temporary fixture: ${session?.cwd}`);
expect(records.some((record) => record.type === "model_change" && record.model === expected.model), "missing expected OMP model selection");

const userTurns = records
  .map((record, index) => ({ record, index }))
  .filter(({ record }) => record.type === "message" && record.message?.role === "user");
const prompts = userTurns.map(({ record }) => record.message.content?.find((part) => part.type === "text")?.text);
expect(JSON.stringify(prompts) === JSON.stringify([expected.firstPrompt, expected.secondPrompt, expected.thirdPrompt]), "the three persisted prompts were not the gate prompts in order");

for (const record of records) {
  if (record.type !== "message" || record.message?.role !== "assistant") continue;
  expect(record.message.provider === expected.provider, `assistant response used unexpected provider: ${record.message.provider}`);
  expect(record.message.model === expected.modelUid, `assistant response used unexpected model: ${record.message.model}`);
  for (const part of record.message.content ?? []) {
    if (part.type === "toolCall") expect(["glob", "read", "inspect_image"].includes(part.name), `disallowed tool appeared in trace: ${part.name}`);
  }
}

function toolUseForTurn(turnIndex, path) {
  const start = userTurns[turnIndex].index;
  const end = userTurns[turnIndex + 1]?.index ?? records.length;
  for (let index = start + 1; index < end; index += 1) {
    const record = records[index];
    if (record.type !== "message" || record.message?.role !== "assistant") continue;
    const toolCall = record.message.content?.find((part) => part.type === "toolCall" && part.name === "read" && part.arguments?.path === path);
    if (toolCall) return { toolCall, start: index, end };
  }
  fail(`turn ${turnIndex + 1} did not call read for ${path}`);
}

function directoryUseForFirstTurn() {
  const start = userTurns[0].index;
  const end = userTurns[1].index;
  for (let index = start + 1; index < end; index += 1) {
    const record = records[index];
    if (record.type !== "message" || record.message?.role !== "assistant") continue;
    const toolCall = record.message.content?.find((part) =>
      part.type === "toolCall" && (
        (part.name === "read" && part.arguments?.path === ".") ||
        (part.name === "glob" && part.arguments?.path === "*" && part.arguments?.hidden === false)
      ),
    );
    if (toolCall) return { toolCall, start: index, end };
  }
  fail("turn 1 did not list non-hidden files with read '.' or glob '*' (hidden=false)");
}

function resultForToolUse(toolUse) {
  for (let index = toolUse.start + 1; index < toolUse.end; index += 1) {
    const record = records[index];
    if (record.type === "message" && record.message?.role === "toolResult" && record.message.toolCallId === toolUse.toolCall.id) return record.message;
  }
  fail(`tool result was missing for ${toolUse.toolCall.arguments.path}`);
}

const directoryUse = directoryUseForFirstTurn();
const directoryResult = resultForToolUse(directoryUse);
expect(directoryResult.isError === false, "directory read failed");
if (directoryUse.toolCall.name === "read") {
  expect(directoryResult.details?.isDirectory === true, "first read was not a directory listing");
  expect(directoryResult.details?.resolvedPath === fixturePath, `directory read escaped fixture: ${directoryResult.details?.resolvedPath}`);
} else {
  const files = directoryResult.details?.files;
  const expectedFiles = ["01_almanac.txt", "02_cobalt.txt", "03_delta.md", "04_ember.json", "05_fjord.txt", "06_orange-kite.png"];
  expect(directoryResult.details?.scopePath === "." && directoryResult.details?.cwd === fixturePath, "glob escaped fixture root");
  expect(directoryResult.details?.fileCount === expectedFiles.length && Array.isArray(files) && files.length === expectedFiles.length, "glob did not return exactly six non-hidden fixture files");
  expect(expectedFiles.every((file) => files.includes(file)) && files.every((file) => !file.startsWith(".")), "glob result did not exclude the hidden fixture or omitted an expected file");
}

const secondFileResult = resultForToolUse(toolUseForTurn(1, "02_cobalt.txt"));
expect(secondFileResult.isError === false, "second-file read failed");
expect(secondFileResult.details?.meta?.source?.value === resolve(fixturePath, "02_cobalt.txt"), "second-file read escaped fixture");
expect((secondFileResult.content ?? []).some((part) => part.type === "text" && part.text.includes(expected.secondFileContent)), "second-file tool result omitted the required content");

const imageResult = resultForToolUse(toolUseForTurn(2, "06_orange-kite.png"));
expect(imageResult.isError === false, "image read failed");
expect(imageResult.details?.meta?.source?.value === resolve(fixturePath, "06_orange-kite.png"), "image read escaped fixture");
expect((imageResult.content ?? []).some((part) => part.type === "image"), "image tool result omitted its image content block");
' "$session_file" "$runtime_fixture_dir"

printf '%s agent gate passed\nmodel: %s\nturn1: %s\nturn2: %s\nturn3: %s\n' \
  "$agent_gate_name" "$agent_gateway_model_uid" "$first" "$second" "$third"
