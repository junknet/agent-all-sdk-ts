import { detectLocalCredits } from './auth.js'
import { listDeepSeekModels } from './deepseek_routes.js'
import { createAnthropicPassthroughProvider } from './providers/anthropic_passthrough_provider.js'
import {
  createAntigravityProvider,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_MODEL_META,
  resolveAntigravityModel,
} from './providers/antigravity_provider.js'
import { createCodexProvider } from './providers/codex_provider.js'
import type { ModelInfo, ThinkingEffort } from './types.js'

type CatalogSource = 'antigravity' | 'codex' | 'claude'

interface PublicModelPolicy extends Omit<ModelInfo, 'name'> {
  readonly source: CatalogSource
}

export interface CatalogSources {
  readonly antigravity: readonly ModelInfo[]
  readonly codex: readonly ModelInfo[]
  readonly claude: readonly ModelInfo[]
}

export interface GatewayModelCapabilities {
  readonly inputModalities: readonly ('text' | 'image')[]
  readonly tools: boolean
  readonly thinking: boolean
  readonly thinkingEfforts: readonly ThinkingEffort[]
  readonly defaultThinkingEffort?: ThinkingEffort
  readonly canDisableThinking: boolean
  readonly protocols: readonly ('anthropic-messages' | 'openai-chat' | 'openai-responses')[]
}

export interface GatewayModelObject {
  readonly id: string
  readonly object: 'model'
  readonly created: 0
  readonly owned_by: 'local-gw'
  readonly name: string
  readonly supported_endpoint_types: readonly ['anthropic', 'openai']
  readonly context_length: number
  readonly context_window: number
  readonly max_input_tokens: number
  readonly max_output_tokens: number
  readonly capabilities: GatewayModelCapabilities
}

export interface GatewayModelsList {
  readonly object: 'list'
  readonly data: readonly GatewayModelObject[]
}

const COMMON_REASONING_EFFORTS: readonly ThinkingEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function antigravityMaxOutputTokens(publicModelId: string): number {
  const route = resolveAntigravityModel(publicModelId)
  const maxOutputTokens = ANTIGRAVITY_MODEL_META[route]?.maxOutputTokens
  if (!maxOutputTokens) {
    throw new Error(`No Antigravity route metadata for public model: ${publicModelId}`)
  }
  return maxOutputTokens
}

/**
 * Public gateway catalog policy. Provider catalogs only prove availability;
 * they never decide which legacy/internal models this gateway advertises.
 *
 * ── contextWindow 的取证状态（2026-08-03，未改数值，只记账）────────────────
 * 下游 harness 拿 context_length 算压缩阈值(70% 触发)，报大了就压得太晚。三家的
 * 一手证据如下，其中 codex 一档拿不到确证，所以整表**维持现状 1_048_576 不动**，
 * 等一手数字齐了再一起改：
 *
 *   gemini-3.6-flash-*  1_048_576  ✅ 与声明一致
 *       来源：cloudcode-pa `v1internal:fetchAvailableModels` 的 `maxTokens` 字段
 *       (实测直接打该端点，三个档位都回 1048576 / maxOutputTokens 65536)。
 *
 *   claude-*            1_000_000  ⚠ 声明 1_048_576，超报 4.9%
 *       来源：`GET api.anthropic.com/v1/models` 的 `max_input_tokens`
 *       (opus-5 / sonnet-5 / fable-5 / opus-4-8 全是 1000000，max_tokens 128000)。
 *
 *   gpt-5.6-*           未知，但**远小于** 1_048_576  ❌ 明确超报
 *       上游 `chatgpt.com/backend-api/codex/models` 还没收录 5.6 系；同代
 *       gpt-5.5/5.4 报 context_window=272_000。流量日志(960 次 codex 请求)里
 *       成功过的最大 input_tokens = 371_756，再往上就是
 *       `context_length_exceeded`("Your input exceeds the context window")，
 *       4 天内没有任何一次 >371_756 的成功。真实上限落在 (371_756, ≪1_048_576]，
 *       要钉死需要再做一轮二分，每次要真烧几十万输入 token 的订阅额度。
 */
const PUBLIC_MODEL_POLICY: readonly PublicModelPolicy[] = [
  {
    id: 'gemini-3.6-flash-high',
    source: 'antigravity',
    supportsImages: true,
    supportsTools: true,
    supportsThinking: true,
    thinkingEfforts: ['high'],
    defaultThinkingEffort: 'high',
    canDisableThinking: false,
    contextWindow: 1_048_576,
    maxOutputTokens: antigravityMaxOutputTokens('gemini-3.6-flash-high'),
  },
  {
    id: 'gemini-3.6-flash-medium',
    source: 'antigravity',
    supportsImages: true,
    supportsTools: true,
    supportsThinking: true,
    thinkingEfforts: ['medium'],
    defaultThinkingEffort: 'medium',
    canDisableThinking: false,
    contextWindow: 1_048_576,
    maxOutputTokens: antigravityMaxOutputTokens('gemini-3.6-flash-medium'),
  },
  {
    id: 'gemini-3.6-flash-low',
    source: 'antigravity',
    supportsImages: true,
    supportsTools: true,
    supportsThinking: true,
    thinkingEfforts: ['low'],
    defaultThinkingEffort: 'low',
    canDisableThinking: false,
    contextWindow: 1_048_576,
    maxOutputTokens: antigravityMaxOutputTokens('gemini-3.6-flash-low'),
  },
  ...(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const).map(
    (id): PublicModelPolicy => ({
      id,
      source: 'codex',
      supportsImages: true,
      supportsTools: true,
      supportsThinking: true,
      thinkingEfforts: ['low', 'medium', 'high'],
      defaultThinkingEffort: 'high',
      canDisableThinking: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 128_000,
    }),
  ),
  ...(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8'] as const).map(
    (id): PublicModelPolicy => ({
      id,
      source: 'claude',
      supportsImages: true,
      supportsTools: true,
      supportsThinking: true,
      thinkingEfforts: [...COMMON_REASONING_EFFORTS],
      defaultThinkingEffort: 'high',
      // claude-fable-5 不接受显式关思考：thinking:{type:'disabled'} 上游 400
      // "\"thinking.type.disabled\" is not supported for this model."(实测 2026-08-03，
      // 同批 opus-5 / sonnet-5 / opus-4-8 都接受)。下游 harness 按这个字段决定要不要
      // 发 effort=none，报 true 就是在诱导它发一个必然 400 的请求。
      canDisableThinking: id !== 'claude-fable-5',
      contextWindow: 1_048_576,
      maxOutputTokens: 128_000,
    }),
  ),
] as const

function idsOf(models: readonly ModelInfo[]): ReadonlySet<string> {
  return new Set(models.map(model => model.id))
}

/** Build the stable public catalog from provider availability snapshots. */
export function buildAvailableModelCatalog(sources: CatalogSources): ModelInfo[] {
  const availableBySource: Readonly<Record<CatalogSource, ReadonlySet<string>>> = {
    antigravity: idsOf(sources.antigravity),
    codex: idsOf(sources.codex),
    claude: idsOf(sources.claude),
  }
  const providerModels = PUBLIC_MODEL_POLICY.filter(policy =>
    availableBySource[policy.source].has(policy.id),
  ).map(({ source: _source, ...model }) => ({
    ...model,
    name: model.id,
    thinkingEfforts: model.thinkingEfforts ? [...model.thinkingEfforts] : undefined,
  }))
  const deepSeekModels: ModelInfo[] = listDeepSeekModels().map(descriptor => ({
    id: descriptor.id,
    name: descriptor.id,
    supportsImages: descriptor.supportsImages,
    supportsTools: descriptor.supportsTools,
    supportsThinking: descriptor.supportsThinking,
    thinkingEfforts: [...descriptor.thinkingEfforts],
    defaultThinkingEffort: descriptor.thinkingEfforts[0],
    canDisableThinking: descriptor.canDisableThinking,
    contextWindow: descriptor.contextWindow,
    maxOutputTokens: descriptor.maxOutputTokens,
  }))
  return [...providerModels, ...deepSeekModels]
}

async function isolateCatalog(
  source: CatalogSource,
  load: () => Promise<readonly ModelInfo[]>,
): Promise<readonly ModelInfo[]> {
  try {
    return await load()
  } catch (error: any) {
    console.error(`listModels ${source} failed:`, error?.message ?? error)
    return []
  }
}

/** Query independent provider catalogs concurrently, then apply gateway policy. */
export async function listAvailableModels(): Promise<ModelInfo[]> {
  const credits = detectLocalCredits()
  const codexCredit = credits.find(credit => credit.provider === 'codex')
  const claudeCredit = credits.find(credit => credit.provider === 'claude')

  const [antigravity, codex, claude] = await Promise.all([
    isolateCatalog('antigravity', async () => {
      const provider = createAntigravityProvider({ model: ANTIGRAVITY_DEFAULT_MODEL })
      await provider.prepare?.()
      return (await provider.listModels?.()) ?? []
    }),
    isolateCatalog('codex', async () => {
      if (codexCredit?.type !== 'oauth' || !codexCredit.source) return []
      const provider = createCodexProvider({ source: codexCredit.source })
      await provider.prepare?.()
      return (await provider.listModels?.()) ?? []
    }),
    isolateCatalog('claude', async () => {
      if (!claudeCredit) return []
      const provider = createAnthropicPassthroughProvider({
        baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        apiKey: claudeCredit.type === 'api_key' ? (claudeCredit.value ?? '') : '',
        model: 'claude-opus-5',
        ...(claudeCredit.type === 'oauth' && claudeCredit.source
          ? { source: claudeCredit.source }
          : {}),
      })
      await provider.prepare?.()
      return (await provider.listModels?.()) ?? []
    }),
  ])

  return buildAvailableModelCatalog({ antigravity, codex, claude })
}

function positive(value: number | undefined, field: string, modelId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Cannot publish model '${modelId}': ${field} must be a positive number`)
  }
  return value
}

export function createModelsListResponse(models: readonly ModelInfo[]): GatewayModelsList {
  const seen = new Set<string>()
  const data = models.map(model => {
    if (!model.id || seen.has(model.id)) {
      throw new Error(`Cannot publish duplicate or empty model id '${model.id}'`)
    }
    seen.add(model.id)
    const thinking = model.supportsThinking ?? false
    return {
      id: model.id,
      object: 'model' as const,
      created: 0 as const,
      owned_by: 'local-gw' as const,
      // Deliberately exact: the selector shown to a user is also the routed id.
      name: model.id,
      supported_endpoint_types: ['anthropic', 'openai'] as const,
      context_length: positive(model.contextWindow, 'contextWindow', model.id),
      context_window: positive(model.contextWindow, 'contextWindow', model.id),
      max_input_tokens: positive(model.contextWindow, 'contextWindow', model.id),
      max_output_tokens: positive(model.maxOutputTokens, 'maxOutputTokens', model.id),
      capabilities: {
        inputModalities: model.supportsImages ? (['text', 'image'] as const) : (['text'] as const),
        tools: model.supportsTools ?? true,
        thinking,
        thinkingEfforts: thinking ? (model.thinkingEfforts ?? []) : [],
        ...(model.defaultThinkingEffort
          ? { defaultThinkingEffort: model.defaultThinkingEffort }
          : {}),
        canDisableThinking: thinking && (model.canDisableThinking ?? false),
        protocols: ['anthropic-messages', 'openai-chat', 'openai-responses'] as const,
      },
    }
  })
  return { object: 'list', data }
}
