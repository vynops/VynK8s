import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  provider: 'anthropic',
  streamText: vi.fn(),
  fetch: vi.fn(),
  createOpenAI: vi.fn(() => () => ({})),
}))

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
  existsSync: () => true,
  readFileSync: () => JSON.stringify({
    ai_provider: mocks.provider,
    ai_api_key: 'test-only',
    ai_model: mocks.provider === 'anthropic' ? 'claude-sonnet-5-5' : 'openai/gpt-oss-120b',
  }),
}))
vi.mock('ai', () => ({
  streamText: mocks.streamText,
  tool: (definition: unknown) => definition,
}))
vi.mock('@/lib/anthropic', () => ({ createAnthropicModel: () => ({}) }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.createOpenAI }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => ({}) }))
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { email: 'test@example.invalid' } }) }))
vi.mock('@/lib/rate-limit', () => ({ createRateLimiter: () => () => ({ ok: true }) }))
vi.mock('@/lib/ai-usage', () => ({ recordAIUsage: vi.fn(), getAIUsageFailure: vi.fn() }))
vi.mock('@/lib/cluster', () => ({
  resolveClusterMeta: async () => null,
  resolveK8sUrl: vi.fn(),
  resolvePromUrl: vi.fn(),
  resolveAlertmanagerUrl: vi.fn(),
  K8S_TIMEOUT_MS: 100,
}))

import { POST } from './route'

beforeEach(() => {
  mocks.provider = 'anthropic'
  mocks.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ summary: ['checked'] })))
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.streamText.mockReset().mockReturnValue({
    toDataStreamResponse: () => new Response(null, { status: 200 }),
  })
  mocks.createOpenAI.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat generation options', () => {
  it.each(['anthropic', 'groq'])('uses compatible sampling options for %s', async (provider) => {
    mocks.provider = provider
    const response = await POST(new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Check cluster health' }] }),
    }))

    expect(response.status).toBe(200)
    expect(mocks.streamText).toHaveBeenCalledOnce()
    const options = mocks.streamText.mock.calls[0][0]
    if (provider === 'anthropic') expect(options).not.toHaveProperty('temperature')
    else expect(options.temperature).toBe(0.1)
  })

  it('requests usage stats in strict mode, so custom/self-hosted models report real token counts', async () => {
    mocks.provider = 'groq'
    await POST(new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Check cluster health' }] }),
    }))
    expect(mocks.createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ compatibility: 'strict' }))
  })

  it('keeps diagnostic sessions and cluster selection isolated per chat request', async () => {
    for (const suffix of ['a', 'b']) {
      await POST(new Request('http://localhost/api/ai/chat', {
        method: 'POST',
        headers: {
          cookie: `test-session=${suffix}`,
          'x-k8s-url': `https://cluster-${suffix}.example.invalid`,
          'x-prom-url': `https://metrics-${suffix}.example.invalid`,
          'x-internal-secret': 'must-not-forward',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Investigate the pod' }] }),
      }))
    }

    for (const [index, suffix] of ['a', 'b'].entries()) {
      const options = mocks.streamText.mock.calls[index][0]
      const result = await options.tools.correlate_pod_issue.execute({ namespace: 'default', pod: 'test-pod', windowMinutes: 5 })
      expect(result).toMatchObject({ source: 'live', summary: ['checked'] })
      const [url, init] = mocks.fetch.mock.calls[index]
      expect(new URL(url).hostname).toBe('127.0.0.1')
      expect(new URL(url).pathname).toBe('/api/k8s/correlate')
      expect(new URL(url).searchParams.get('window')).toBe('300')
      const headers = new Headers(init.headers)
      expect(headers.get('cookie')).toBe(`test-session=${suffix}`)
      expect(headers.get('x-k8s-url')).toBe(`https://cluster-${suffix}.example.invalid`)
      expect(headers.get('x-prom-url')).toBe(`https://metrics-${suffix}.example.invalid`)
      expect(headers.has('x-internal-secret')).toBe(false)
      expect(headers.has('authorization')).toBe(false)
    }
  })

  it('surfaces diagnostic authorization failures rather than bypassing them', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }))
    await POST(new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    }))
    const result = await mocks.streamText.mock.calls[0][0].tools.correlate_pod_issue.execute({
      namespace: 'default', pod: 'test-pod', windowMinutes: 5,
    })
    expect(result).toEqual({ error: 'Correlation API returned 401' })
  })

  it('authenticates incident lookups using the requesting session', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ incidents: [] })))
    await POST(new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      headers: { cookie: 'test-session=incidents' },
      body: JSON.stringify({ messages: [] }),
    }))
    const result = await mocks.streamText.mock.calls[0][0].tools.get_incidents.execute({ severity: 'all', state: 'all' })
    expect(result).toMatchObject({ count: 0 })
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/incidents')
    expect(new Headers(init.headers).get('cookie')).toBe('test-session=incidents')
  })
})
