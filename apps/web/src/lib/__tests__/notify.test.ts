import { describe, expect, it } from 'vitest'
import { teamsPayload } from '../notify'

describe('teamsPayload', () => {
  it('carries the card under attachments[0].content and a plain text fallback', () => {
    const p = teamsPayload('Title', 'Detail', 'https://example.invalid/incidents?id=1')
    expect(p.type).toBe('message')
    expect(p.attachments[0].content.type).toBe('AdaptiveCard')
    expect(p.attachments[0].content.body).toHaveLength(2)
    expect(p.attachments[0].content.actions?.[0].url).toBe('https://example.invalid/incidents?id=1')
    expect(p.text).toContain('Title')
    expect(p.text).toContain('Detail')
  })

  it('serializes to valid JSON and omits actions without a url', () => {
    const p = teamsPayload('T', 'line1\nline2')
    expect(() => JSON.parse(JSON.stringify(p))).not.toThrow()
    expect(p.attachments[0].content.actions).toBeUndefined()
  })
})
