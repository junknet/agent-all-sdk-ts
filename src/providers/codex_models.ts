/** ChatGPT Codex 的公开模型目录与客户端模型映射；不包含任何协议转换。 */
export const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Latest frontier agentic coding model' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced agentic coding model for everyday work' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Fast and affordable agentic coding model' },
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong model for everyday coding' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Small, fast, cost-efficient for simpler coding' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'Ultra-fast coding model' },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(candidate => candidate.id === model)
}

export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.6-sol'
  if (lower.includes('sonnet')) return 'gpt-5.6-terra'
  if (lower.includes('haiku')) return 'gpt-5.6-luna'
  return DEFAULT_CODEX_MODEL
}
