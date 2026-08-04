import { describe, expect, test } from 'bun:test'
import { createProviderCatalogCache, type CatalogDiscoverySource } from '../src/model_catalog.js'
import type { ModelInfo } from '../src/types.js'

const model = (id: string): ModelInfo => ({ id, name: id })

describe('provider model catalog discovery cache', () => {
  test('times out a stalled provider and caches its unavailable result', async () => {
    let calls = 0
    const failures: Array<{ source: CatalogDiscoverySource; message: string }> = []
    const cache = createProviderCatalogCache({
      discoveryTimeoutMs: 10,
      failureTtlMs: 1_000,
      reportFailure: (source, error) => failures.push({
        source,
        message: error instanceof Error ? error.message : String(error),
      }),
    })
    const stalled = (): Promise<readonly ModelInfo[]> => {
      calls += 1
      return new Promise(() => {})
    }

    const startedAt = performance.now()
    expect(await cache.load('claude', stalled)).toEqual([])
    expect(performance.now() - startedAt).toBeLessThan(250)
    expect(await cache.load('claude', stalled)).toEqual([])

    expect(calls).toBe(1)
    expect(failures).toEqual([
      { source: 'claude', message: 'model catalog discovery for claude timed out after 10ms' },
    ])
  })

  test('caches successful snapshots until their TTL expires without sharing state between cache instances', async () => {
    let now = 1_000
    let firstCacheCalls = 0
    const firstCache = createProviderCatalogCache({
      now: () => now,
      successTtlMs: 100,
      discoveryTimeoutMs: 100,
    })
    const discoverFirst = async (): Promise<readonly ModelInfo[]> => {
      firstCacheCalls += 1
      return [model(`first-${firstCacheCalls}`)]
    }

    expect(await firstCache.load('codex', discoverFirst)).toEqual([model('first-1')])
    now += 99
    expect(await firstCache.load('codex', discoverFirst)).toEqual([model('first-1')])
    now += 1
    expect(await firstCache.load('codex', discoverFirst)).toEqual([model('first-2')])

    const secondCache = createProviderCatalogCache({ discoveryTimeoutMs: 100 })
    expect(await secondCache.load('codex', async () => [model('second-cache')])).toEqual([model('second-cache')])
    expect(firstCacheCalls).toBe(2)
  })

  test('keeps provider cache keys independent and coalesces concurrent discovery for one provider', async () => {
    let release: ((models: readonly ModelInfo[]) => void) | undefined
    let antigravityCalls = 0
    const cache = createProviderCatalogCache({ discoveryTimeoutMs: 100, reportFailure: () => {} })
    const slowAntigravity = (): Promise<readonly ModelInfo[]> => {
      antigravityCalls += 1
      return new Promise(resolve => {
        release = resolve
      })
    }

    const first = cache.load('antigravity', slowAntigravity)
    const second = cache.load('antigravity', slowAntigravity)
    const codex = cache.load('codex', async () => [model('codex-only')])
    await Promise.resolve()
    release?.([model('gemini-only')])

    expect(await first).toEqual([model('gemini-only')])
    expect(await second).toEqual([model('gemini-only')])
    expect(await codex).toEqual([model('codex-only')])
    expect(antigravityCalls).toBe(1)
  })
})
