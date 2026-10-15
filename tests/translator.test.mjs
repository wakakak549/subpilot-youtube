import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ApiError, TranslationCache, TranslationService, requestBody, requestChat, listModels } from '../extension/lib/translator.js';

const Core = globalThis.YTAICore;
const merged = JSON.parse(await readFile(new URL('./fixtures/hy-merged-paragraph.json', import.meta.url), 'utf8'));
const config = Core.normalizeConfig({ apiKey: 'test-key' });
const payload = {
  videoId: 'abcdefghijk', trackId: 'en:caption-hash',
  lines: [{ id: 0, text: 'Hello.' }, { id: 4, text: 'World.' }],
  context_before: ['Previous.'], context_after: ['Next.']
};
const answer = items => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: items }) } }] }));
const all = [{ id: 0, text: '你好。' }, { id: 4, text: '世界。' }];
function memoryStorage() {
  const data = {};
  return {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; }
  };
}

test('gpt-6.1-sol requests use supported low reasoning and omit temperature', () => {
  const body = requestBody(config, payload.lines);
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.temperature, undefined);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.max_completion_tokens, 8192);
});

test('successful translations are cached and provider changes invalidate that cache', async () => {
  let calls = 0;
  const cache = new TranslationCache(memoryStorage());
  const service = new TranslationService(cache, { fetcher: async () => { calls++; return answer(all); } });
  assert.equal((await service.translate(config, payload)).translations.length, 2);
  const repeated = await service.translate(config, payload);
  assert.equal(calls, 1);
  assert.equal(repeated.cached, 2);
  await service.translate({ ...config, baseURL: 'https://other.example/v1' }, payload);
  assert.equal(calls, 2);
  await service.translate({ ...config, targetLang: 'English' }, payload);
  assert.equal(calls, 3);
});

test('partial replies retry only missing IDs and preserve already translated lines', async () => {
  const attempts = [], waits = [];
  const service = new TranslationService(new TranslationCache(memoryStorage()), {
    fetcher: async (_, options) => {
      attempts.push(JSON.parse(JSON.parse(options.body).messages[1].content).subtitles.map(line => line.id));
      return answer(attempts.length === 1 ? [all[0]] : [all[1]]);
    },
    sleep: async ms => { waits.push(ms); }
  });
  const result = await service.translate(config, payload);
  assert.deepEqual(attempts, [[0, 4], [4]]);
  assert.deepEqual(result.translations, all);
  assert.deepEqual(waits, [800]);
  assert.equal(result.error, null);
});

test('empty JSON stops after three attempts rather than looping indefinitely', async () => {
  let calls = 0;
  const waits = [];
  const service = new TranslationService(new TranslationCache(memoryStorage()), {
    fetcher: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); },
    sleep: async ms => { waits.push(ms); }
  });
  const result = await service.translate(config, payload);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [800, 1600]);
  assert.equal(result.error.code, 'FORMAT');
});

test('authentication and configuration errors are not automatically retried', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const service = new TranslationService(new TranslationCache(memoryStorage()), {
      fetcher: async () => { calls++; return new Response('', { status }); },
      sleep: async () => assert.fail('Fatal errors must not retry')
    });
    const result = await service.translate(config, payload);
    assert.equal(calls, 1);
    assert.ok(result.error);
  }
});

test('rate limits respect Retry-After and still have bounded retry attempts', async () => {
  let calls = 0;
  const waits = [];
  const service = new TranslationService(new TranslationCache(memoryStorage()), {
    fetcher: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : answer(all),
    sleep: async ms => { waits.push(ms); }
  });
  assert.equal((await service.translate(config, payload)).error, null);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test('cancellation aborts in-flight requests and prevents another attempt or cache write', async () => {
  const controller = new AbortController();
  const cache = new TranslationCache(memoryStorage());
  let calls = 0, started;
  const entered = new Promise(resolve => { started = resolve; });
  const service = new TranslationService(cache, { fetcher: async (_, options) => {
    calls++; started();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const translating = service.translate(config, payload, controller.signal);
  await entered;
  controller.abort();
  await assert.rejects(translating, error => error.code === 'CANCELLED');
  assert.equal(calls, 1);
  assert.equal((await cache.stats()).entries, 0);
});

test('request timeouts terminate rather than leaving a pending queue', async () => {
  const fetcher = async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(requestChat(config, payload.lines, [], [], null, fetcher, 20), error => error.code === 'TIMEOUT');
});

test('unauthenticated local APIs omit Authorization and optional provider parameters', async () => {
  const local = Core.normalizeConfig({ baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'local-model', reasoningEffort: 'auto', structuredOutput: false });
  await requestChat(local, payload.lines, [], [], null, async (_, options) => {
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.response_format, undefined);
    return answer(all);
  });
});

test('LM Studio uses /v1, max_tokens and Hy-MT2-compatible prompt with a Hy model', async () => {
  const local = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-1.8b' });
  await requestChat(local, payload.lines, [], [], null, async (url, options) => {
    assert.equal(url, 'http://localhost:1234/v1/chat/completions');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.response_format, undefined);
    assert.equal(body.temperature, 0.7);
    return answer(all);
  });
});

test('explicit API formats support local OpenAI proxies and remote LM Studio', () => {
  const proxy = Core.normalizeConfig({ baseURL: 'http://localhost:1234/v1', apiFormat: 'openai' });
  const body = requestBody(proxy, payload.lines);
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.reasoning_effort, 'low');
  const remote = requestBody(Core.normalizeConfig({ baseURL: 'http://192.168.1.8:1234', apiFormat: 'compatible' }), payload.lines);
  assert.equal(remote.max_tokens, 1024);
  assert.equal(remote.reasoning_effort, undefined);
});

test('Hy-MT2 uses its plain translation prompt and recommended sampling instead of JSON schema', () => {
  const cfg = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const body = requestBody(cfg, payload.lines, ['Previous.'], ['Next.']);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.6);
  assert.equal(body.top_k, 20);
  assert.equal(body.repetition_penalty, 1.05);
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content, /只需要输出翻译后的结果/);
  assert.match(body.messages[0].content, /\[0\] Hello\./);
  assert.match(body.messages[0].content, /\[4\] World\./);
  assert.match(body.messages[0].content, /保留各行开头的数字标记/);
  assert.doesNotMatch(body.messages[0].content, /严格要求|每个输入编号必须返回一行|\n1\./);
  assert.doesNotMatch(body.messages[0].content, /Previous|Next|参考信息/);
});

test('Hy-MT2 plain responses translate all IDs and cache them', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const cache = new TranslationCache(memoryStorage());
  let sent;
  const service = new TranslationService(cache, { fetcher: async (_, options) => {
    const body = JSON.parse(options.body);
    sent = body;
    return new Response(JSON.stringify({ choices: [{ message: { content: '[0] 你好，世界。\n[4] 世界。' } }] }));
  } });
  const result = await service.translate(hy, payload);
  assert.deepEqual(result.translations, [{ id: 0, text: '你好，世界。' }, { id: 4, text: '世界。' }]);
  assert.equal(result.error, null);
  assert.equal(sent.response_format, undefined);
  assert.equal(sent.temperature, 0.7);
  assert.equal((await service.translate(hy, payload)).cached, 2);
});

test('Hy-MT2 prompt echoes retry only rejected IDs with a simple single-subtitle prompt', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const storage = memoryStorage(), cache = new TranslationCache(storage);
  const prompts = [];
  const service = new TranslationService(cache, { fetcher: async (_, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    if (prompts.length === 2) {
      assert.equal((await cache.stats()).entries, 1);
      assert.doesNotMatch(JSON.stringify(await storage.get('translationCache')), /每个输入编号/);
    }
    const content = prompts.length === 1 ? '[0] 你好。\n[4] 每个输入编号必须返回一行，保持原顺序。' : '世界。';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }, sleep: async () => {} });
  const result = await service.translate(hy, payload);
  assert.equal(result.error, null);
  assert.deepEqual(result.translations, all);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].split('\n\n').at(-1), 'World.');
  assert.doesNotMatch(prompts[1], /\[\d+\]|参考信息|Previous|Next|数字标记/);
  assert.equal((await service.translate(hy, payload)).cached, 2);
  assert.equal(prompts.length, 2);
});

test('persistent prompt echoes are bounded, reported and never cached', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const cache = new TranslationCache(memoryStorage());
  let calls = 0;
  const service = new TranslationService(cache, { fetcher: async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '每个输入编号必须返回一行' } }] }));
  }, sleep: async () => {} });
  const result = await service.translate(hy, { ...payload, lines: [payload.lines[0]] });
  assert.equal(calls, 3);
  assert.equal(result.error.code, 'FORMAT');
  assert.deepEqual(result.translations, []);
  assert.equal((await cache.stats()).entries, 0);
});

test('invalid single-subtitle responses are retried and can recover', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  let calls = 0;
  const service = new TranslationService(new TranslationCache(memoryStorage()), { fetcher: async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? null : '你好。' } }] }));
  }, sleep: async () => {} });
  const result = await service.translate(hy, { ...payload, lines: [payload.lines[0]] });
  assert.equal(calls, 2);
  assert.equal(result.error, null);
  assert.deepEqual(result.translations, [all[0]]);
});

test('simple single-subtitle translation preserves numeric content through parsing and cache reuse', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  for (const text of ['2026. 第十期', '1. 打开字幕。', '温度是 0.7，阈值是 0.6，时间是 12:30。']) {
    let calls = 0;
    const service = new TranslationService(new TranslationCache(memoryStorage()), { fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
    } });
    const single = { ...payload, lines: [{ id: 1, text: '2026. Step 1. Set temperature to 0.7 and threshold to 0.6 at 12:30.' }] };
    assert.deepEqual((await service.translate(hy, single)).translations, [{ id: 1, text }]);
    const cached = await service.translate(hy, single);
    assert.deepEqual(cached.translations, [{ id: 1, text }]);
    assert.equal(cached.cached, 1);
    assert.equal(calls, 1);
  }
});

test('ordinary JSON responses also reject echoes of their actual instructions', async () => {
  let calls = 0;
  const cache = new TranslationCache(memoryStorage());
  const service = new TranslationService(cache, { fetcher: async () => {
    calls++;
    return answer(calls === 1 ? [{ id: 0, text: 'Translate only requested subtitles.' }, all[1]] : [all[0]]);
  }, sleep: async () => {} });
  const result = await service.translate(config, payload);
  assert.equal(calls, 2);
  assert.equal(result.error, null);
  assert.deepEqual(result.translations, all);
  assert.equal((await cache.stats()).entries, 2);
});

test('cache upgrade discards old paragraphs while retaining API configuration', async () => {
  for (const version of [3, 4]) {
    const storage = memoryStorage();
    await storage.set({ config, translationCache: { version, entries: { old: { text: merged.rawResponse, used: Date.now() } } } });
    const cache = new TranslationCache(storage);
    assert.equal((await cache.stats()).entries, 0);
    assert.deepEqual(await storage.get('config'), { config });
  }
});

test('Hy-MT2 isolates the entire incomplete response to prevent shifted IDs from being cached', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const lines = Array.from({ length: 40 }, (_, id) => ({ id, text: `Sentence ${id}.` }));
  const cache = new TranslationCache(memoryStorage());
  const requested = [];
  const service = new TranslationService(cache, {
    fetcher: async (_, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.messages[0].content;
      const ids = [...prompt.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
      if (!ids.length) ids.push(Number(prompt.match(/Sentence (\d+)\./)[1]));
      requested.push(ids);
      const output = requested.length === 1 ? ids.slice(0, 2) : ids;
      return new Response(JSON.stringify({ choices: [{ message: {
        content: output.map(id => `[${id}] 译文 ${id}`).join('\n')
      } }] }));
    },
    sleep: async () => {}
  });
  const result = await service.translate(hy, { ...payload, lines });
  assert.equal(result.error, null);
  assert.equal(result.translations.length, lines.length);
  assert.equal(requested[0].length, 40);
  assert.deepEqual(requested.slice(1), lines.map(line => [line.id]));
});

test('actual cached paragraph is replaced by an isolated translation and never stored', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const storage = memoryStorage(), cache = new TranslationCache(storage);
  const expected = '主要目标。如果没有 SCV 带领死神，那就有可能';
  let calls = 0;
  const service = new TranslationService(cache, { fetcher: async (_, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).messages[0].content.split('\n\n').at(-1), merged.source.text);
    if (calls === 2) assert.equal((await cache.stats()).entries, 0);
    return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? merged.rawResponse : expected } }] }));
  }, sleep: async () => {} });
  const single = { ...payload, lines: [merged.source] };
  const result = await service.translate(hy, single);
  assert.equal(calls, 2);
  assert.equal(result.error, null);
  assert.deepEqual(result.translations, [{ id: 34, text: expected }]);
  assert.doesNotMatch(JSON.stringify(await storage.get('translationCache')), /Zerklings|Taran/);
  assert.equal((await service.translate(hy, single)).cached, 1);
});

test('invalid cached text is revalidated against its own source cue before reuse', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const single = { ...payload, lines: [merged.source] };
  let reads = 0;
  const cache = new TranslationCache(memoryStorage());
  cache.get = async () => { reads++; return [merged.rawResponse]; };
  const service = new TranslationService(cache, { fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: '主要目标。如果没有 SCV 带领死神，那就有可能' } }] })) });
  const result = await service.translate(hy, single);
  assert.equal(reads, 1);
  assert.equal(result.cached, 0);
  assert.equal(result.requests, 1);
  assert.equal(result.error, null);
});

test('100 merged subtitles recover in single-cue requests without the former 24-request budget cutting them off', async () => {
  const hy = Core.normalizeConfig({ baseURL: 'http://localhost:1234', model: 'hy-mt2-7b' });
  const lines = Array.from({ length: 100 }, (_, id) => ({ id, text: `Sentence ${id}.` }));
  let calls = 0;
  const cache = new TranslationCache(memoryStorage());
  const service = new TranslationService(cache, { fetcher: async (_, options) => {
    calls++;
    const prompt = JSON.parse(options.body).messages[0].content;
    const id = Number(prompt.split('\n\n').at(-1).match(/^Sentence (\d+)\./)?.[1]);
    const content = calls === 1 ? lines.map(line => `句子 ${line.id}。`).join('') : `句子 ${id}。`;
    if (calls > 1) assert.ok(Number.isInteger(id));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }, sleep: async () => {} });
  const result = await service.translate(hy, { ...payload, lines });
  assert.equal(result.error, null);
  assert.equal(result.translations.length, 100);
  assert.equal(calls, 101);
  assert.deepEqual(result.translations, lines.map(line => ({ id: line.id, text: `句子 ${line.id}。` })));
  assert.equal((await service.translate(hy, { ...payload, lines })).cached, 100);
});

test('100-subtitle requests grow their output budget and return and cache every ID', async () => {
  const lines = Array.from({ length: 100 }, (_, id) => ({ id, text: `Sentence ${id}.` }));
  const translations = lines.map(({ id }) => ({ id, text: `译文 ${id}` }));
  const cache = new TranslationCache(memoryStorage());
  let calls = 0;
  const service = new TranslationService(cache, { fetcher: async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.max_completion_tokens, 12800);
    assert.equal(JSON.parse(body.messages[1].content).subtitles.length, 100);
    return answer(translations);
  } });
  assert.equal((await service.translate(config, { ...payload, lines })).error, null);
  const repeated = await service.translate(config, { ...payload, lines });
  assert.equal(repeated.cached, 100);
  assert.deepEqual(repeated.translations, translations);
  assert.equal(calls, 1);
  assert.equal(requestBody(Core.normalizeConfig({ baseURL: 'http://localhost:1234' }), lines).max_tokens, 12800);
});

test('provider errors in HTTP 200 are reported once, with credentials redacted', async () => {
  let calls = 0;
  const service = new TranslationService(new TranslationCache(memoryStorage()), { fetcher: async () => {
    calls++;
    return new Response(JSON.stringify({ error: `Unexpected endpoint. Bearer ${config.apiKey}` }));
  }, sleep: async () => assert.fail('Endpoint errors must not retry') });
  const result = await service.translate(config, payload);
  assert.equal(calls, 1);
  assert.equal(result.error.code, 'CONFIG');
  assert.match(result.error.message, /Unexpected endpoint/);
  assert.ok(!result.error.message.includes(config.apiKey));
});

test('model discovery preserves IDs and credentials, removes duplicates and embedding models', async () => {
  const local = Core.normalizeConfig({ baseURL: 'http://localhost:1234', apiKey: 'local-auth-token' });
  const models = await listModels(local, async (url, options) => {
    assert.equal(url, 'http://localhost:1234/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer local-auth-token');
    return new Response(JSON.stringify({ data: [
      { id: 'hy-mt2-1.8b' }, { id: 'hy-mt2-1.8b' }, { id: 'qwen3.6-35b-a3b' },
      { id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'other-embedder', type: 'embeddings' }, null
    ] }));
  });
  assert.deepEqual(models, ['hy-mt2-1.8b', 'qwen3.6-35b-a3b']);
  await assert.rejects(listModels(local, async () => new Response('{}')), error => error.code === 'FORMAT');
});

test('cache evicts older entries and clear removes persistent data', async () => {
  const storage = memoryStorage();
  const cache = new TranslationCache(storage, { maxEntries: 2, maxBytes: 10000 });
  await cache.put({ a: 'A', b: 'B' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await cache.put({ c: 'C' });
  assert.equal((await cache.stats()).entries, 2);
  assert.equal((await cache.get(['c']))[0], 'C');
  await cache.clear();
  assert.equal((await new TranslationCache(storage).stats()).entries, 0);
});

test('storage quota errors preserve returned translations and do not trigger more API calls', async () => {
  const storage = memoryStorage();
  storage.set = async () => { throw new Error('Quota exceeded'); };
  let calls = 0;
  const service = new TranslationService(new TranslationCache(storage), { fetcher: async () => { calls++; return answer(all); } });
  const result = await service.translate(config, payload);
  assert.equal(calls, 1);
  assert.equal(result.translations.length, 2);
  assert.equal(result.cacheWarning, true);
  assert.equal(result.error, null);
});
