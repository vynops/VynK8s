import { describe, expect, it } from 'vitest'
import { getAIUsageFailure, summarizeAIUsageByDayModel, summarizeAIUsageBySource } from '@/lib/ai-usage'

describe('getAIUsageFailure()', () => {
  it('extracts Groq token-limit details without retaining the raw error', () => {
    const details = getAIUsageFailure({
      name: 'AI_RetryError',
      message: 'Failed after 3 attempts. Last error: Rate limit reached for model openai/gpt-oss-120b in organization org-private on tokens per minute (TPM): Limit 8,000, Used 6,620, Requested 2,966. Please try again in 11.895s.',
      statusCode: 429,
    })

    expect(details).toMatchObject({
      status: 'error',
      statusCode: 429,
      errorType: 'rate_limit',
      retryAfterSecs: 12,
      rateLimitUnit: 'tokens_per_minute',
      rateLimitLimit: 8000,
      rateLimitUsed: 6620,
      rateLimitRequested: 2966,
    })
    expect(JSON.stringify(details)).not.toContain('org-private')
    expect(JSON.stringify(details)).not.toContain('gpt-oss-120b')
  })

  it('records generic provider errors without copying their message', () => {
    const details = getAIUsageFailure(new Error('upstream failed with private response data'))

    expect(details).toMatchObject({ status: 'error', errorType: 'provider_error' })
    expect(JSON.stringify(details)).not.toContain('private response data')
  })

  it('summarizes usage by source and treats legacy entries as Copilot', () => {
    const summary = summarizeAIUsageBySource([
      { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      { source: 'copilot', status: 'error', errorType: 'rate_limit' },
      { source: 'autonomous_plan', status: 'success', promptTokens: 300, completionTokens: 40, totalTokens: 340 },
    ])

    expect(summary.copilot).toMatchObject({ requests: 2, successfulRequests: 1, failedRequests: 1, rateLimitErrors: 1, totalTokens: 120 })
    expect(summary.autonomousPlan).toMatchObject({ requests: 1, successfulRequests: 1, failedRequests: 0, totalTokens: 340 })
  })

  it('groups the last 7 days by date and model, newest first', () => {
    const daily = summarizeAIUsageByDayModel([
      { ts: '2026-11-10T10:00:00Z', provider: 'groq', model: 'openai/gpt-oss-120b', totalTokens: 999 },
      { ts: '2026-11-11T10:00:00Z', provider: 'groq', model: 'openai/gpt-oss-120b', totalTokens: 6000 },
      { ts: '2026-11-18T09:00:00Z', provider: 'groq', model: 'openai/gpt-oss-120b', totalTokens: 13500 },
      { ts: '2026-11-18T10:00:00Z', provider: 'anthropic', model: 'claude-sonnet-5-5', totalTokens: 30000 },
      { ts: '2026-11-18T11:00:00Z', provider: 'anthropic', model: 'claude-sonnet-5-5', status: 'error' },
      { provider: 'groq', model: 'no-timestamp', totalTokens: 5 },
    ], 8, new Date('2026-11-18T12:00:00Z'))

    expect(daily.map(d => [d.date, d.model, d.requests, d.totalTokens])).toEqual([
      ['2026-11-18', 'claude-sonnet-5-5', 2, 30000],
      ['2026-11-18', 'openai/gpt-oss-120b', 1, 13500],
      ['2026-11-11', 'openai/gpt-oss-120b', 1, 6000],
    ])
    expect(daily[0]).toMatchObject({ provider: 'anthropic', failedRequests: 1 })
  })
})