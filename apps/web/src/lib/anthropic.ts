import { createAnthropic } from '@ai-sdk/anthropic'
import { wrapLanguageModel } from 'ai'

export function createAnthropicModel(apiKey: string, model: string) {
  return wrapLanguageModel({
    model: createAnthropic({ apiKey })(model),
    middleware: {
      // AI SDK v4 injects temperature=0 even when callers omit it.
      transformParams: async ({ params }) => ({ ...params, temperature: undefined }),
    },
  })
}
