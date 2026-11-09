import config from '../config.js';
import { createFakeProvider } from './fake.js';

/**
 * Provider factory.
 *
 * `gemini.js` is imported lazily so the service - and the whole test suite - boots
 * with no API key and no SDK initialisation when LLM_PROVIDER=fake.
 */
export async function createLLMProvider(overrides = {}) {
  const settings = { ...config.llm, ...overrides };

  if (settings.provider === 'fake') {
    return createFakeProvider({
      latencyMs: settings.fake.latencyMs,
      failureRate: settings.fake.failureRate,
      failureMode: settings.fake.failureMode,
    });
  }

  if (settings.provider === 'gemini') {
    const { createGeminiProvider } = await import('./gemini.js');
    return createGeminiProvider({
      apiKey: settings.apiKey,
      model: settings.model,
      maxOutputTokens: settings.maxTokens,
      thinkingLevel: settings.thinkingLevel,
      timeoutMs: settings.timeoutMs,
      structuredOutput: settings.structuredOutput,
    });
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${settings.provider}`);
}
