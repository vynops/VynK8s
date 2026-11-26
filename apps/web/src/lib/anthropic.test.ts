import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText, streamText } from 'ai'
import { createAnthropicModel } from './anthropic'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Anthropic request compatibility', () => {
  it.each(['generate', 'stream'] as const)('omits SDK-defaulted temperature from the %s HTTP body', async (mode) => {
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => mode === 'generate'
      ? new Response(JSON.stringify(message), { headers: { 'Content-Type': 'application/json' } })
      : new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const options = {
      model: createAnthropicModel('test-only', 'claude-sonnet-5-5'),
      prompt: 'Reply only with OK.',
      maxTokens: 16,
      maxRetries: 0,
    }

    if (mode === 'generate') {
      expect((await generateText(options)).text).toBe('OK')
    } else {
      const result = streamText(options)
      await result.consumeStream()
      expect(await result.text).toBe('OK')
    }
    expect(fetchMock).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).not.toHaveProperty('temperature')
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.max_tokens).toBe(16)
    expect(body.stream === true).toBe(mode === 'stream')
  })
})
