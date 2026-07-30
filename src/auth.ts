import fs from 'fs'
import os from 'os'
import path from 'path'
import type { QuotaInfo } from './types.js'

export interface Credit {
  provider: string
  type: 'api_key' | 'oauth'
  value?: string
  accountId?: string
  source?: TokenSource
}

export interface TokenSource {
  token(): Promise<string>
  refresh?(): Promise<void>
  getQuota?(): Promise<QuotaInfo>
}

// ── JWT expiry helper ───────────────────────────────────────────────
export function jwtExpiry(token: string): Date | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf-8')
    const claims = JSON.parse(payload)
    if (typeof claims.exp === 'number') {
      return new Date(claims.exp * 1000)
    }
  } catch {}
  return null
}

// ── Cross-Platform Credentials Path Resolver ────────────────────────
export function getPlatformCredentialsPath(provider: 'claude' | 'codex'): string {
  const customDir = process.env.GATEWAY_CREDENTIALS_DIR
  if (customDir) {
    return provider === 'claude'
      ? path.join(customDir, 'claude_credentials.json')
      : path.join(customDir, 'codex_auth.json')
  }

  const home = os.homedir()
  const isWin = process.platform === 'win32'
  if (provider === 'claude') {
    return path.join(home, '.claude', '.credentials.json')
  } else {
    if (isWin && process.env.APPDATA) {
      return path.join(process.env.APPDATA, 'codex', 'auth.json')
    }
    return path.join(home, '.codex', 'auth.json')
  }
}

// ── Memory Token Source (Centralized Cookie Management) ─────────────
export class MemoryTokenSource implements TokenSource {
  private provider: 'claude' | 'codex' | 'gemini'
  private accessToken: string
  private refreshToken?: string
  private expiresAt: number = 0
  private quota: QuotaInfo = {}

  constructor(provider: 'claude' | 'codex' | 'gemini', accessToken: string, refreshToken?: string) {
    this.provider = provider
    this.accessToken = accessToken
    this.refreshToken = refreshToken
    const exp = jwtExpiry(accessToken)
    if (exp) {
      this.expiresAt = exp.getTime()
    }
  }

  expired(): boolean {
    if (!this.accessToken) return true
    if (this.expiresAt === 0) return false
    return Date.now() + 60000 > this.expiresAt
  }

  async token(): Promise<string> {
    if (!this.expired()) {
      return this.accessToken
    }
    if (!this.refreshToken) {
      throw new Error(`memory-oauth (${this.provider}): accessToken expired and no refreshToken available`)
    }
    await this.refresh()
    return this.accessToken
  }

  async refresh(): Promise<void> {
    if (this.provider === 'claude') {
      try {
        await this.postRefreshClaude(CLAUDE_SCOPES)
      } catch (err) {
        if (err instanceof Error && err.message.includes('invalid_scope')) {
          await this.postRefreshClaude('')
        } else {
          throw err
        }
      }
    } else if (this.provider === 'codex') {
      await this.postRefreshCodex()
    }
  }

  private async postRefreshClaude(scope: string): Promise<void> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken!,
      client_id: CLAUDE_CLIENT_ID,
    }
    if (scope) {
      body.scope = scope
    }

    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CLAUDE_USER_AGENT,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`claude-oauth refresh failed: ${res.status} ${errText}`)
    }

    const tok = (await res.json()) as any
    if (!tok.access_token) {
      throw new Error('claude-oauth token response missing access_token')
    }

    this.accessToken = tok.access_token
    if (tok.refresh_token) {
      this.refreshToken = tok.refresh_token
    }
    if (tok.expires_in) {
      this.expiresAt = Date.now() + tok.expires_in * 1000
    }
    if (tok.scope) {
      this.quota.tier = tok.rateLimitTier
      this.quota.planType = tok.subscriptionType
    }
  }

  private async postRefreshCodex(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: this.refreshToken!,
    })

    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`codex-oauth refresh failed: ${res.status} ${errText}`)
    }

    const tok = (await res.json()) as any
    if (!tok.access_token) {
      throw new Error('codex-oauth token response missing access_token')
    }

    this.accessToken = tok.access_token
    if (tok.refresh_token) {
      this.refreshToken = tok.refresh_token
    }
    const idToken = tok.id_token
    if (idToken) {
      const parts = idToken.split('.')
      if (parts.length >= 2) {
        try {
          const payload = Buffer.from(parts[1]!, 'base64url').toString('utf-8')
          const claims = JSON.parse(payload)
          this.quota.planType = claims['https://api.openai.com/auth.gpt_plan_type'] || claims['https://api.openai.com/auth.chatgpt_plan_type']
        } catch {}
      }
    }
  }

  async getQuota(): Promise<QuotaInfo> {
    return this.quota
  }
}

// ── Claude OAuth Source ──────────────────────────────────────────────
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_USER_AGENT = 'claude-cli/2.1.123 (external, sdk-cli)'
const CLAUDE_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

export class ClaudeOAuthSource implements TokenSource {
  private filePath: string
  private tokens: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes?: string[]
    subscriptionType?: string
    rateLimitTier?: string
  }

  constructor(filePath?: string) {
    this.filePath = filePath || getPlatformCredentialsPath('claude')
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`claude-oauth: file not found at ${this.filePath}`)
    }
    const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    if (!data.claudeAiOauth || (!data.claudeAiOauth.accessToken && !data.claudeAiOauth.refreshToken)) {
      throw new Error(`claude-oauth: no claudeAiOauth block in ${this.filePath}`)
    }
    this.tokens = data.claudeAiOauth
  }

  expired(): boolean {
    if (!this.tokens.accessToken) return true
    if (this.tokens.expiresAt === 0) return false
    return Date.now() + 60000 > this.tokens.expiresAt
  }

  async token(): Promise<string> {
    if (!this.expired()) {
      return this.tokens.accessToken
    }
    if (!this.tokens.refreshToken) {
      throw new Error(`claude-oauth: accessToken expired and no refreshToken available in ${this.filePath}`)
    }
    await this.refresh()
    return this.tokens.accessToken
  }

  async refresh(): Promise<void> {
    try {
      await this.postRefresh(CLAUDE_SCOPES)
    } catch (err) {
      if (err instanceof Error && err.message.includes('invalid_scope')) {
        await this.postRefresh('')
      } else {
        throw err
      }
    }
  }

  private async postRefresh(scope: string): Promise<void> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }
    if (scope) {
      body.scope = scope
    }

    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CLAUDE_USER_AGENT,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`claude-oauth refresh failed: ${res.status} ${errText}`)
    }

    const tok = (await res.json()) as any
    if (!tok.access_token) {
      throw new Error('claude-oauth token response missing access_token')
    }

    this.tokens.accessToken = tok.access_token
    if (tok.refresh_token) {
      this.tokens.refreshToken = tok.refresh_token
    }
    if (tok.expires_in) {
      this.tokens.expiresAt = Date.now() + tok.expires_in * 1000
    }
    if (tok.scope) {
      this.tokens.scopes = tok.scope.split(/\s+/)
    }
    this.save()
  }

  private save(): void {
    const envelope = { claudeAiOauth: this.tokens }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(envelope, null, 2) + '\n', 'utf-8')
  }

  async getQuota(): Promise<QuotaInfo> {
    return {
      tier: this.tokens.rateLimitTier,
      planType: this.tokens.subscriptionType,
    }
  }
}

// ── Codex OAuth Source ──────────────────────────────────────────────
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'

export class CodexOAuthSource implements TokenSource {
  private filePath: string
  private fileData: {
    auth_mode?: string
    OPENAI_API_KEY?: string
    tokens: {
      id_token?: string
      access_token: string
      refresh_token: string
      account_id?: string
    }
    last_refresh?: string
  }

  constructor(filePath?: string) {
    this.filePath = filePath || getPlatformCredentialsPath('codex')
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`codex-oauth: file not found at ${this.filePath}`)
    }
    const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    if (!data.tokens || (!data.tokens.access_token && !data.tokens.refresh_token)) {
      throw new Error(`codex-oauth: no tokens block in ${this.filePath}`)
    }
    this.fileData = data
  }

  accountId(): string {
    return this.fileData.tokens.account_id || ''
  }

  expired(): boolean {
    if (!this.fileData.tokens.access_token) return true
    const exp = jwtExpiry(this.fileData.tokens.access_token)
    if (!exp) return true
    return Date.now() + 60000 > exp.getTime()
  }

  async token(): Promise<string> {
    if (!this.expired()) {
      return this.fileData.tokens.access_token
    }
    if (!this.fileData.tokens.refresh_token) {
      throw new Error(`codex-oauth: access_token expired and no refresh_token in ${this.filePath}`)
    }
    await this.refresh()
    return this.fileData.tokens.access_token
  }

  async refresh(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: this.fileData.tokens.refresh_token,
    })

    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`codex-oauth refresh failed: ${res.status} ${errText}`)
    }

    const tok = (await res.json()) as any
    if (!tok.access_token) {
      throw new Error('codex-oauth token response missing access_token')
    }

    this.fileData.tokens.access_token = tok.access_token
    if (tok.refresh_token) {
      this.fileData.tokens.refresh_token = tok.refresh_token
    }
    if (tok.id_token) {
      this.fileData.tokens.id_token = tok.id_token
    }
    this.fileData.last_refresh = new Date().toISOString()
    this.save()
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.fileData, null, 2) + '\n', 'utf-8')
  }

  async getQuota(): Promise<QuotaInfo> {
    const idToken = this.fileData.tokens.id_token
    if (!idToken) return {}
    const parts = idToken.split('.')
    if (parts.length < 2) return {}
    try {
      const payload = Buffer.from(parts[1]!, 'base64url').toString('utf-8')
      const claims = JSON.parse(payload)
      return {
        planType: claims['https://api.openai.com/auth.gpt_plan_type'] || claims['https://api.openai.com/auth.chatgpt_plan_type']
      }
    } catch {}
    return {}
  }
}

// ── Local/Dynamic Credits Detector ──────────────────────────────────
export interface CustomTokens {
  claudeAccessToken?: string
  claudeRefreshToken?: string
  codexAccessToken?: string
  codexRefreshToken?: string
  geminiAccessToken?: string
}

export function detectLocalCredits(opts?: { customTokens?: CustomTokens }): Credit[] {
  const credits: Credit[] = []
  const ct = opts?.customTokens

  // --- Claude ---
  if (ct?.claudeAccessToken || ct?.claudeRefreshToken) {
    const source = new MemoryTokenSource('claude', ct.claudeAccessToken || '', ct.claudeRefreshToken)
    credits.push({ provider: 'claude', type: 'oauth', source })
  } else if (process.env.GATEWAY_CLAUDE_ACCESS_TOKEN || process.env.GATEWAY_CLAUDE_TOKEN) {
    const source = new MemoryTokenSource('claude', process.env.GATEWAY_CLAUDE_ACCESS_TOKEN || process.env.GATEWAY_CLAUDE_TOKEN || '', process.env.GATEWAY_CLAUDE_REFRESH_TOKEN)
    credits.push({ provider: 'claude', type: 'oauth', source })
  } else if (process.env.ANTHROPIC_API_KEY) {
    credits.push({ provider: 'claude', type: 'api_key', value: process.env.ANTHROPIC_API_KEY })
  } else {
    try {
      const claudeSource = new ClaudeOAuthSource()
      credits.push({ provider: 'claude', type: 'oauth', source: claudeSource })
    } catch {}
  }

  // --- Codex / OpenAI ---
  if (ct?.codexAccessToken || ct?.codexRefreshToken) {
    const source = new MemoryTokenSource('codex', ct.codexAccessToken || '', ct.codexRefreshToken)
    credits.push({ provider: 'codex', type: 'oauth', source })
  } else if (process.env.GATEWAY_CODEX_ACCESS_TOKEN || process.env.GATEWAY_CODEX_TOKEN) {
    const source = new MemoryTokenSource('codex', process.env.GATEWAY_CODEX_ACCESS_TOKEN || process.env.GATEWAY_CODEX_TOKEN || '', process.env.GATEWAY_CODEX_REFRESH_TOKEN)
    credits.push({ provider: 'codex', type: 'oauth', source })
  } else if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
    const key = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY
    credits.push({ provider: 'codex', type: 'api_key', value: key })
  } else {
    try {
      const codexSource = new CodexOAuthSource()
      credits.push({
        provider: 'codex',
        type: 'oauth',
        source: codexSource,
        accountId: codexSource.accountId(),
      })
    } catch {}
  }

  // --- Gemini direct API key or OAuth Token ---
  if (ct?.geminiAccessToken) {
    const source = new MemoryTokenSource('gemini', ct.geminiAccessToken)
    credits.push({ provider: 'gemini', type: 'oauth', source })
  } else if (process.env.GATEWAY_GEMINI_ACCESS_TOKEN || process.env.GATEWAY_GEMINI_TOKEN) {
    const source = new MemoryTokenSource('gemini', process.env.GATEWAY_GEMINI_ACCESS_TOKEN || process.env.GATEWAY_GEMINI_TOKEN || '')
    credits.push({ provider: 'gemini', type: 'oauth', source })
  } else if (process.env.GOOGLE_API_KEY) {
    credits.push({ provider: 'gemini', type: 'api_key', value: process.env.GOOGLE_API_KEY })
  }

  return credits
}
