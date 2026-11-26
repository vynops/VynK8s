import { describe, expect, it } from 'vitest'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

describe('Google provider compatibility', () => {
  it('uses the v1 model specification required by AI SDK 4', () => {
    const model = createGoogleGenerativeAI({ apiKey: 'test-key' })('gemini-2.5-flash')

    expect(model.specificationVersion).toBe('v1')
  })
})