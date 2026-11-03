import type { ProviderRow } from '../db';
import { createAnthropicClient } from './anthropic';
import { createGeminiClient } from './gemini';
import { createMockClient } from './mock';
import { createOpenAIClient } from './openai';
import type { LLMClient } from './types';

export function createClient(provider: ProviderRow): LLMClient {
  if (provider.kind === 'anthropic') {
    return createAnthropicClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  }
  if (provider.kind === 'gemini') {
    return createGeminiClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  }
  if (provider.kind === 'mock') return createMockClient();
  return createOpenAIClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  });
}

export function providerNeedsKey(kind: ProviderRow['kind']): boolean {
  return kind !== 'mock';
}
