import { describe, expect, test } from 'bun:test'
import {
  createWindsurfAgentIrProvider,
  loadWindsurfCredentials,
  parseWindsurfCredentialsToml,
  windsurfModelUid,
} from '../src/providers/windsurf_agent_ir_provider.js'
import { resolveModel } from '../src/index.js'

describe('Windsurf agent-ir provider', () => {
  test('only the explicit windsurf prefix selects this egress', () => {
    expect(windsurfModelUid('windsurf-claude-sonnet-5-medium')).toBe('claude-sonnet-5-medium')
    expect(windsurfModelUid('claude-sonnet-5-medium')).toBeNull()
    expect(windsurfModelUid('windsurf-')).toBeNull()
    expect(resolveModel('windsurf-claude-haiku-4-5', '思考').model)
      .toBe('windsurf-claude-haiku-4-5')
  })

  test('environment credential is injected without reading a workstation file', () => {
    expect(loadWindsurfCredentials({
      WINDSURF_API_KEY: 'test-token',
      WINDSURF_SERVER_URL: 'http://127.0.0.1:1',
    })).toEqual({ apiKey: 'test-token', server: 'http://127.0.0.1:1' })
  })

  test('reads only root Windsurf TOML keys and accepts trailing comments', () => {
    const credentials = parseWindsurfCredentialsToml(`
windsurf_api_key = "root-token" # workstation credential
api_server_url = 'https://root.example.test' # endpoint

[other_provider]
windsurf_api_key = "other-token"
api_server_url = "https://other.example.test"
`)

    expect(credentials).toEqual({
      apiKey: 'root-token',
      server: 'https://root.example.test',
    })
  })

  test('rejects duplicate, syntactically invalid, or non-string TOML credentials', () => {
    expect(() => parseWindsurfCredentialsToml(`
windsurf_api_key = "first-token"
windsurf_api_key = "second-token"
`)).toThrow('credentials.toml is invalid TOML')

    expect(() => parseWindsurfCredentialsToml('windsurf_api_key = "unterminated')).toThrow(
      'credentials.toml is invalid TOML',
    )

    expect(() => parseWindsurfCredentialsToml(`
windsurf_api_key = ["not", "a string"]
`)).toThrow('windsurf_api_key must be a non-empty string')
  })

  test('lowers an Anthropic request into raw Connect protobuf bytes', async () => {
    const provider = createWindsurfAgentIrProvider({
      model: 'claude-sonnet-5-medium',
      apiKey: 'test-token',
      server: 'http://127.0.0.1:1',
    })
    const prepared = await provider.buildRequest({
      model: 'windsurf-claude-sonnet-5-medium',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(prepared.headers['content-type']).toBe('application/connect+proto')
    expect(prepared.body).toBeInstanceOf(Uint8Array)
    expect((prepared.body as Uint8Array).byteLength).toBeGreaterThan(5)
  })
})
