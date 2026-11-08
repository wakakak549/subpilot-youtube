import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { TranslationCache, TranslationService } from '../extension/lib/translator.js';

const Core = globalThis.YTAICore;
const baseURL = Core.normalizeBaseURL(process.env.YTAI_LOCAL_API || 'http://127.0.0.1:1234');
assert.ok(Core.isLocalAPI(baseURL), 'This check only connects to a loopback API');
const inventoryResponse = await fetch(new URL('/api/v0/models', baseURL), { signal: AbortSignal.timeout(15000) });
assert.ok(inventoryResponse.ok, 'LM Studio model inventory must be available');
const inventory = await inventoryResponse.json();
const loaded = inventory.data.filter(item => item.type === 'llm' && item.state === 'loaded' && Core.isHyMTModel(item.id));
const model = process.env.YTAI_LOCAL_MODEL || loaded[0]?.id;
assert.ok(loaded.some(item => item.id === model), 'Load a Hy-MT2 model before running this check; no models were loaded or switched');
const config = Core.normalizeConfig({ baseURL, model, apiKey: '', useContext: true, batchSize: 8 });
const data = {};
const storage = {
  async get(key) { return structuredClone({ [key]: data[key] }); },
  async set(values) { Object.assign(data, structuredClone(values)); },
  async remove(key) { delete data[key]; }
};
const rawReplies = [];
const service = new TranslationService(new TranslationCache(storage), {
  fetcher: async (url, options) => {
    const response = await fetch(url, options);
    const body = await response.clone().json();
    rawReplies.push({ prompt: JSON.parse(options.body).messages[0].content, content: body.choices?.[0]?.message?.content });
    return response;
  }
});
const cases = [
  {
    name: 'river', videoTitle: 'River hiking: crossing a flooded river safely',
    context_before: ['We are hiking beside a river after a storm.', 'The river has overflowed its banks.'],
    texts: ['The bank is steep here.', 'It collapsed after the heavy rain.', 'We should stay away from the edge.',
      'The current is much stronger today.', 'He is waiting on the other side.', 'Pass him the rope first.',
      'Keep it above the water.', 'We can cross together.'],
    context_after: ['Once we reach the shore, we can rest.']
  },
  {
    name: 'finance', videoTitle: 'Opening a savings account at a bank',
    context_before: ['I need somewhere to deposit my savings.', 'The branch is next to the station.'],
    texts: ['The bank is busy today.', 'She is waiting at the counter.', 'They need to check her ID first.',
      'This account has no monthly fee.', 'The interest rate is higher this year.', 'You can transfer the money online.',
      'Keep the receipt for your records.', 'We can come back tomorrow.'],
    context_after: ['The teller will help us finish the application.']
  }
];
const results = [];
for (const scenario of cases) {
  const payload = {
    videoId: 'contextdemo', trackId: 'en:' + scenario.name, videoTitle: scenario.videoTitle,
    context_before: scenario.context_before, context_after: scenario.context_after,
    lines: scenario.texts.map((text, index) => ({ id: index + 10, text }))
  };
  const started = performance.now();
  const result = await service.translate(config, payload, AbortSignal.timeout(120000));
  assert.equal(result.error, null);
  assert.deepEqual(result.translations.map(line => line.id), payload.lines.map(line => line.id));
  for (const line of result.translations) assert.doesNotMatch(line.text, /【背景信息】|【待翻译文本】|保留各行开头的数字标记/);
  const repeated = await service.translate(config, payload, AbortSignal.timeout(15000));
  assert.equal(repeated.requests, 0);
  assert.equal(repeated.cached, payload.lines.length);
  const record = { scenario: scenario.name, elapsedMs: Math.round(performance.now() - started), ...result, repeatedCacheHits: repeated.cached };
  results.push(record);
  console.log(JSON.stringify(record));
}
const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
await writeFile(new URL('context-real-model-results.json', artifacts), JSON.stringify({
  date: new Date().toISOString(), baseURL, model, results, rawReplies,
  limits: 'Constructed examples on an already loaded model; not an end-to-end real-video quality evaluation.'
}, null, 2));
