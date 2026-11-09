import config from '../config.js';
import { createFakeProvider } from './fake.js';

/**
 * Provider factory.
 *
 * `anthropic.js` is imported lazily so the service - and the whole test suite - boots
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

  if (settings.provider === 'anthropic') {
    const { createAnthropicProvider } = await import('./anthropic.js');
    return createAnthropicProvider({
      apiKey: settings.apiKey,
      model: settings.model,
      maxTokens: settings.maxTokens,
      effort: settings.effort,
      timeoutMs: settings.timeoutMs,
      structuredOutput: settings.structuredOutput,
    });
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${settings.provider}`);
}
