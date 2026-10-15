import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { readFile } from 'node:fs/promises';
import '../extension/lib/core.js';

globalThis.DOMParser = DOMParser;
const Core = globalThis.YTAICore;
const videoA = 'abcdefghijk';
const merged = JSON.parse(await readFile(new URL('./fixtures/hy-merged-paragraph.json', import.meta.url), 'utf8'));
const shifted = JSON.parse(await readFile(new URL('./fixtures/hy-shifted-numbering.json', import.meta.url), 'utf8'));

test('JSON3 ignores empty append events and clips overlapping display windows', () => {
  const cues = Core.parseCaptions(JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hello ' }, { utf8: 'world.' }] },
    { tStartMs: 1000, segs: [{ utf8: '\n' }], aAppend: 1 },
    { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Second line.' }] },
    { tStartMs: 6000 }
  ] }));
  assert.deepEqual(cues, [
    { start: 0, end: 2000, text: 'Hello world.' },
    { start: 2000, end: 4000, text: 'Second line.' }
  ]);
});

test('legacy XML and srv3 preserve decoded text and timestamps', () => {
  assert.deepEqual(Core.parseCaptions('<transcript><text start="1.25" dur="2">Tom &amp; Jerry.</text></transcript>'),
    [{ start: 1250, end: 3250, text: 'Tom & Jerry.' }]);
  assert.deepEqual(Core.parseCaptions('<timedtext><body><p t="500" d="1500"><s>A </s><s>sentence.</s></p></body></timedtext>'),
    [{ start: 500, end: 2000, text: 'A sentence.' }]);
});

test('grouping merges fragments but respects punctuation and gaps', () => {
  const groups = Core.groupCues([
    { start: 0, end: 1000, text: 'A short' },
    { start: 1000, end: 2000, text: 'sentence.' },
    { start: 3000, end: 4000, text: 'Next.' }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].text, 'A short sentence.');
  assert.equal(groups[0].end, 2000);
  assert.equal(Core.activeIndex(groups, 2500), -1);
  assert.equal(Core.activeIndex(groups, 3000), 1);
});

test('prefetch is bounded, includes the active long cue, and excludes distant subtitles', () => {
  const cues = [
    { id: 0, start: 0, end: 10000, text: 'Current.' },
    { id: 1, start: 10000, end: 12000, text: 'Nearby.' },
    { id: 2, start: 120000, end: 122000, text: 'Distant.' }
  ];
  const batch = Core.pickBatch(cues, 8000, { ...Core.DEFAULTS, prefetchSeconds: 15 });
  assert.deepEqual(batch.lines.map(line => line.id), [0, 1]);
  assert.equal(batch.context_after[0], 'Distant.');
  cues[0].translated = 'Done'; cues[1].translated = 'Done';
  assert.equal(Core.pickBatch(cues, 8000, { ...Core.DEFAULTS, prefetchSeconds: 15 }), null);
});

test('caption URLs and video navigation cannot cross video or origin boundaries', () => {
  assert.equal(Core.getVideoId(`https://www.youtube.com/watch?v=${videoA}`), videoA);
  assert.equal(Core.getVideoId(`https://www.youtube.com/shorts/${videoA}`), null);
  assert.equal(Core.captionURL(`https://www.youtube.com/api/timedtext?v=${videoA}`, 'other012345'), null);
  assert.equal(Core.captionURL(`https://evil.example/api/timedtext?v=${videoA}`, videoA), null);
});

test('JSON output validates IDs, nonempty strings and completeness', () => {
  const lines = [{ id: 2, text: 'A' }, { id: 8, text: 'B' }];
  const result = Core.parseTranslations('```json\n{"translations":[{"id":2,"text":"Good"},{"id":2,"text":"Duplicate"},{"id":8,"text":" "},{"id":99,"text":"Wrong"}]}\n```', lines);
  assert.deepEqual(result.translations, [{ id: 2, text: 'Good' }]);
  assert.deepEqual(result.missing, [lines[1]]);
  assert.equal(Core.parseTranslations('{}', lines).missing.length, 2);
  assert.throws(() => Core.parseTranslations('not JSON', lines));
});

test('configuration preserves the requested model and keeps secrets out of public data', () => {
  const cfg = Core.normalizeConfig({ apiKey: 'secret', prefetchSeconds: 999, batchSize: 0 });
  assert.equal(cfg.model, 'gpt-6.1-sol');
  assert.equal(cfg.reasoningEffort, 'low');
  assert.equal(cfg.prefetchSeconds, 600);
  assert.equal(cfg.batchSize, 1);
  assert.equal(Core.publicConfig(cfg).apiKey, undefined);
  assert.equal(Core.publicConfig(cfg).hasApiKey, true);
  assert.equal(Core.normalizeBaseURL('https://api.example/v1/chat/completions/'), 'https://api.example/v1');
  assert.throws(() => Core.normalizeBaseURL('https://user:secret@api.example/v1'));
  assert.throws(() => Core.normalizeBaseURL('https://api.example/v1?key=secret'));
});

test('larger batches reach 100 subtitles while respecting prefetch and translated entries', () => {
  const cues = Array.from({ length: 130 }, (_, id) => ({ id, start: id * 3000, end: id * 3000 + 2800, text: `Subtitle ${id}.` }));
  const cfg = Core.normalizeConfig({ batchSize: 100, prefetchSeconds: 600 });
  const batch = Core.pickBatch(cues, 0, cfg);
  assert.equal(batch.lines.length, 100);
  assert.deepEqual(batch.context_after, ['Subtitle 100.', 'Subtitle 101.', 'Subtitle 102.']);
  for (const line of batch.lines) cues[line.id].translated = 'Done';
  const remaining = Core.pickBatch(cues, 0, cfg);
  assert.equal(remaining.lines.length, 30);
  assert.equal(remaining.lines[0].id, 100);
  assert.equal(Core.pickBatch(cues, 0, { ...cfg, prefetchSeconds: 45 }), null);
  assert.equal(Core.normalizeConfig({ batchSize: 999 }).batchSize, 100);
  assert.equal(Core.normalizeConfig({ batchSize: 30 }).batchSize, 30);
  assert.equal(Core.normalizeConfig({ batchSize: 6, prefetchSeconds: 45 }).batchSize, 6);
});

test('bare loopback API addresses gain /v1 without changing explicit or remote routes', () => {
  for (const base of ['http://localhost:1234', 'http://127.0.0.1:1234/', 'http://[::1]:1234']) {
    assert.equal(Core.normalizeBaseURL(base), new URL(base).origin + '/v1');
  }
  assert.equal(Core.normalizeBaseURL('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1');
  assert.equal(Core.normalizeBaseURL('http://localhost:1234/custom'), 'http://localhost:1234/custom');
  assert.equal(Core.normalizeBaseURL('https://api.example/'), 'https://api.example');
  assert.equal(Core.normalizeConfig({ apiFormat: 'compatible', baseURL: 'http://192.168.1.8:1234' }).baseURL, 'http://192.168.1.8:1234/v1');
  assert.equal(Core.normalizeConfig({ apiFormat: 'openai', baseURL: 'http://localhost:1234' }).baseURL, 'http://localhost:1234');
  assert.equal(Core.isLocalAPI('http://127.0.0.1:1234/v1'), true);
  assert.equal(Core.isLocalAPI('https://127.evil.example/v1'), false);
  assert.equal(Core.isLocalAPI('https://localhost.evil.example/v1'), false);
  assert.equal(Core.normalizeConfig({}).requestTimeoutSeconds, 120);
  assert.equal(Core.normalizeConfig({ requestTimeoutSeconds: 999 }).requestTimeoutSeconds, 300);
});

test('Hy-MT2 numbered plain text is mapped without JSON artefacts', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }];
  assert.equal(Core.isHyMTModel('hy-mt2-7b'), true);
  assert.equal(Core.isHyMTModel('tencent/Hy-MT2-7B-GGUF'), true);
  assert.equal(Core.isHyMTModel('gpt-6.1-sol'), false);
  assert.deepEqual(Core.parseLineTranslations('[4] 你好。\n[9] 打开门。', lines), {
    translations: [{ id: 4, text: '你好。' }, { id: 9, text: '打开门。' }], missing: []
  });
  assert.deepEqual(Core.parseLineTranslations('4. 你好。\n9: 打开门。', lines).missing, []);
  assert.deepEqual(Core.parseLineTranslations('[4] 你好。"}]}。\n[9] 打开门。', lines).translations, [
    { id: 4, text: '你好。' }, { id: 9, text: '打开门。' }
  ]);
  assert.deepEqual(Core.parseLineTranslations('你好。\n打开门。', lines).translations, [
    { id: 4, text: '你好。' }, { id: 9, text: '打开门。' }
  ]);
  assert.deepEqual(Core.parseLineTranslations('{"translations":[{"id":4,"text":"你好。"},{"id":9,"text":"打开门。"}]}', lines).missing, []);
});

test('Hy-MT2 strips numbering and splits multiple translations on one line', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }, { id: 12, text: 'Stay here.' }];
  assert.deepEqual(Core.parseLineTranslations('[4] "你好。" [9] 打开门。 [12] 留在这里。', lines), {
    translations: [
      { id: 4, text: '你好。' }, { id: 9, text: '打开门。' }, { id: 12, text: '留在这里。' }
    ], missing: []
  });
  assert.deepEqual(Core.parseLineTranslations('1. 你好。 2. 打开门。 3. 留在这里。', lines), {
    translations: [
      { id: 4, text: '你好。' }, { id: 9, text: '打开门。' }, { id: 12, text: '留在这里。' }
    ], missing: []
  });
});

test('Hy-MT2 accepts alternate marker styles and cleans cached text by ID', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }];
  assert.deepEqual(Core.parseLineTranslations('<4> 你好。 <9> 打开门。', lines).translations, [
    { id: 4, text: '你好。' }, { id: 9, text: '打开门。' }
  ]);
  assert.deepEqual(Core.parseLineTranslations('4）你好。 9）打开门。', lines).translations, [
    { id: 4, text: '你好。' }, { id: 9, text: '打开门。' }
  ]);
  assert.equal(Core.cleanTranslationText('[4] 你好。 [9] 打开门。', 9), '打开门。');
  assert.equal(Core.cleanTranslationText('"[4] 你好。"', 4), '你好。');
});

test('Hy-MT2 partial unnumbered text is retried without guessing subtitle positions', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }, { id: 12, text: 'Stay here.' }];
  assert.deepEqual(Core.parseLineTranslations('你好。\n打开门。', lines), {
    translations: [], missing: lines, retryIndividually: true
  });
});

test('prompt echoes are rejected in plain, numbered and JSON translations', () => {
  const lines = [{ id: 4, text: 'Hello.' }];
  for (const response of [
    '每个输入编号必须返回一行',
    '[4] 每个输入编号必须返回一行，保持原顺序。',
    '1. 每个输入编号必须返回一行，保持原顺序。\n2. 保留每行开头的 [编号]。',
    '每个输入编号必须返回一行\n你好。',
    '{"translations":[{"id":4,"text":"每个输入编号必须返回一行"}]}',
    '{"translations":[]}'
  ]) {
    const result = Core.parseLineTranslations(response, lines);
    assert.deepEqual(result.translations, []);
    assert.deepEqual(result.missing, lines);
  }
  assert.deepEqual(Core.parseTranslations('{"translations":[{"id":4,"text":"每个输入编号必须返回一行"}]}', lines), {
    translations: [], missing: lines
  });
});

test('mixed echoes keep only translations with reliable source IDs', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }];
  assert.deepEqual(Core.parseLineTranslations('[4] 你好。\n[9] 每个输入编号必须返回一行', lines), {
    translations: [{ id: 4, text: '你好。' }], missing: [lines[1]]
  });
  assert.deepEqual(Core.parseLineTranslations('1. 每个输入编号必须返回一行\n[4] 你好。\n[9] 打开门。', lines), {
    translations: [{ id: 4, text: '你好。' }, { id: 9, text: '打开门。' }], missing: []
  });
  // Removing an echoed row cannot shift the next unnumbered translation to
  // an earlier subtitle, or turn a rule list into positional subtitle IDs.
  for (const response of ['每个输入编号必须返回一行\n打开门。', '1. 每个输入编号必须返回一行\n2. 打开门。']) {
    const result = Core.parseLineTranslations(response, lines);
    assert.deepEqual(result.translations, []);
    assert.deepEqual(result.missing, lines);
  }
});

test('current prompt clauses are checked while genuine source wording is retained', () => {
  const instructions = ['将以下文本翻译为简体中文。只需要输出翻译后的结果，不要额外解释。保留各行开头的数字标记，每行对应一条译文。'];
  const line = { id: 4, text: 'Hello.' };
  for (const text of ['只需要输出翻译后的结果', '保留各行开头的数字标记', '每行对应一条译文']) {
    assert.deepEqual(Core.parseLineTranslations(`[4] 你好。${text}`, [line], instructions).translations, []);
  }
  const source = [{ id: 4, text: '每个输入编号必须返回一行。' }, { id: 9, text: 'In 2026 there are 10 examples.' }];
  assert.deepEqual(Core.parseLineTranslations('[4] 每个输入编号必须返回一行。\n[9] 2026 年有 10 个例子。', source).translations, [
    { id: 4, text: source[0].text }, { id: 9, text: '2026 年有 10 个例子。' }
  ]);
  assert.deepEqual(Core.parseLineTranslations('1. 每个输入编号必须返回一行。\n2. 2026 年有 10 个例子。', source).translations, [
    { id: 4, text: source[0].text }, { id: 9, text: '2026 年有 10 个例子。' }
  ]);
});

test('unrelated numbered rows cannot be mapped to requested subtitles by position', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }];
  assert.deepEqual(Core.parseLineTranslations('[4] 你好。\n[99] 无关内容。', lines), {
    translations: [], missing: lines, retryIndividually: true
  });
});

test('actual screenshot paragraph is rejected for the single subtitle shown above it', () => {
  assert.deepEqual(Core.parseLineTranslations(merged.rawResponse, [merged.source]), { translations: [], missing: [merged.source], retryIndividually: true });
  const text = merged.rawResponse.replace(/^\[34\] /, '');
  assert.deepEqual(Core.parseLineTranslations(text, [merged.source]).translations, []);
  assert.deepEqual(Core.parseTranslations(JSON.stringify({ translations: [{ id: 34, text }] }), [merged.source]).translations, []);
});

test('merged batch output cannot occupy the first subtitle when markers are missing', () => {
  const lines = [{ id: 4, text: 'Hello.' }, { id: 9, text: 'Open the door.' }, { id: 12, text: 'Stay here.' }];
  for (const content of ['你好。打开门。留在这里。', '[4] 你好。打开门。留在这里。', '[4] 你好。\n[12] 打开门。留在这里。']) {
    const result = Core.parseLineTranslations(content, lines);
    assert.equal(result.retryIndividually, true);
    assert.ok(result.missing.length > 0);
    assert.ok(result.translations.every(line => !line.text.includes('打开门。留在这里。')));
  }
});

test('real Hy-MT2 merge-and-renumber output invalidates every row instead of preserving a shifted prefix', () => {
  const result = Core.parseLineTranslations(shifted.response, shifted.lines);
  assert.deepEqual(result, { translations: [], missing: shifted.lines, retryIndividually: true });
});

test('single-subtitle replies cannot hide several numbered translations in one entry', () => {
  const lines = [{ id: 4, text: 'Hello.' }];
  for (const content of ['[4] 你好。 [9] 打开门。', '你好。\n[9] 打开门。', '4. 你好。 9. 打开门。']) {
    assert.deepEqual(Core.parseLineTranslations(content, lines).translations, []);
  }
});

test('normal translations and long genuine sources survive the expansion guard', () => {
  for (const [source, text] of [
    ['Hello.', '你好。'], ['SCV', '太空工程车'], ['Open the door.', '请打开门。'],
    ['main goal. If indeed an SCV is not going to be leading the Reaper, there\'s a', '主要目标。如果没有 SCV 带领死神，那就有可能'],
    ['This command center is very important for the economy and the supply line.', '这个指挥中心对发展经济和保护补给线非常重要。'],
    ['这条补给线非常重要。', 'This supply line is very important.'],
    ['The command center needs protection. '.repeat(12), '指挥中心需要保护。'.repeat(12)]
  ]) assert.equal(Core.isTranslationPlausible(text, source), true, source);
});
