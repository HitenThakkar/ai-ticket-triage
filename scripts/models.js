#!/usr/bin/env node
/**
 * Lists the Gemini models the configured API key can actually use.
 *
 * Gemini model IDs are retired on a published schedule - `gemini-2.5-flash` and
 * `gemini-2.5-pro` are already deprecated - so a model name hard-coded in a service is
 * a future outage. `TRIAGE_MODEL` is configuration, and this script is how you find a
 * value for it that your key accepts today:
 *
 *   npm run models
 */
import config from '../src/config.js';

if (!config.llm.apiKey) {
  process.stderr.write(
    'GEMINI_API_KEY is not set. Get a key from https://aistudio.google.com/apikey\n',
  );
  process.exit(1);
}

const { GoogleGenAI } = await import('@google/genai');
const ai = new GoogleGenAI({ apiKey: config.llm.apiKey });

try {
  const pager = await ai.models.list();
  const rows = [];

  for await (const model of pager) {
    const id = (model.name ?? '').replace(/^models\//, '');
    if (!id) continue;
    rows.push({
      id,
      display: model.displayName ?? '',
      input: model.inputTokenLimit ?? '',
      output: model.outputTokenLimit ?? '',
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));

  const width = Math.max(8, ...rows.map((r) => r.id.length));
  process.stdout.write(`${'MODEL ID'.padEnd(width)}  IN/OUT TOKENS   NAME\n`);
  for (const r of rows) {
    const limits = `${r.input || '?'}/${r.output || '?'}`;
    process.stdout.write(`${r.id.padEnd(width)}  ${limits.padEnd(14)}  ${r.display}\n`);
  }

  process.stdout.write(`\n${rows.length} models available. Currently configured: ${config.llm.model}\n`);
  if (rows.length > 0 && !rows.some((r) => r.id === config.llm.model)) {
    process.stdout.write(
      `WARNING: "${config.llm.model}" is not in this list - triage calls will fail with a 404.\n`,
    );
  }
} catch (err) {
  process.stderr.write(`Could not list models: ${err?.message ?? err}\n`);
  process.exitCode = 1;
}
