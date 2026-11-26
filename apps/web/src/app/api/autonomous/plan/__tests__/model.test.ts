import { describe, expect, it } from 'vitest'
import { resolvePlanModel } from '../shared'

describe('resolvePlanModel', () => {
  it('prefers the saved model over env', () => {
    expect(resolvePlanModel({ ai_model: 'gpt-4o-mini' }, 'openai', { AI_MODEL: 'other' })).toBe('gpt-4o-mini')
  })

  it('replaces a retired Groq model, including a stale groq_model', () => {
    expect(resolvePlanModel({ groq_model: 'llama-3.3-70b-versatile' }, 'groq', {})).toBe('openai/gpt-oss-120b')
  })

  it('falls back to the current Groq default when nothing is set', () => {
    expect(resolvePlanModel({}, 'groq', {})).toBe('openai/gpt-oss-120b')
  })

  it('does not rewrite a retired-looking name for another provider', () => {
    expect(resolvePlanModel({ ai_model: 'llama-3.3-70b-versatile' }, 'custom', {})).toBe('llama-3.3-70b-versatile')
  })
})
