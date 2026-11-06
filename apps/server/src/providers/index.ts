import { isKeylessUrl } from '../free-llm';
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

/** Нужен ли ключ: демо и анонимные бесплатные API (Kilo, LLM7, OVHcloud) работают без него. */
export function providerNeedsKey(
  kind: ProviderRow['kind'],
  baseUrl = '',
): boolean {
  if (kind === 'mock') return false;
  return !isKeylessUrl(baseUrl);
}
