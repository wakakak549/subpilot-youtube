import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const merged = JSON.parse(await readFile(path.join(root, 'tests/fixtures/hy-merged-paragraph.json'), 'utf8'));
const screenshots = path.join(root, 'artifacts');
await mkdir(screenshots, { recursive: true });
const api = { calls: [], bodies: [], status: 200, delay: 0, hyEchoes: 0, hyMergedResponses: 0 };
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [
      { id: 'mock-local-model' }, { id: 'text-embedding-test-model' }
    ] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const hy = /hy-mt2/i.test(body.model);
  const prompt = body.messages[0].content;
  const numbered = hy ? [...prompt.matchAll(/^\[(\d+)\]\s*(.*)$/gm)].map(match => ({ id: Number(match[1]), text: match[2] })) : [];
  const input = hy ? { subtitles: numbered.length ? numbered : [{ id: null, text: prompt.split('\n\n').at(-1) }] } : JSON.parse(body.messages[1].content);
  api.calls.push(input.subtitles);
  api.bodies.push(body);
  const echoId = hy && api.hyEchoes > 0 ? input.subtitles[1]?.id : undefined;
  if (echoId !== undefined) api.hyEchoes--;
  const mergeResponse = hy && api.hyMergedResponses > 0;
  if (mergeResponse) api.hyMergedResponses--;
  const status = api.status, wait = api.delay;
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  response.writeHead(status, { 'Content-Type': 'application/json' });
  if (status !== 200) { response.end('{"error":{"message":"test failure"}}'); return; }
  const content = mergeResponse ? merged.rawResponse.replace('[34]', '[0]') : hy ? input.subtitles.map(line => (line.id === null ? '' : `[${line.id}] `) +
    (line.id === echoId ? '每个输入编号必须返回一行，保持原顺序。' : '译文：' + line.text)).join('\n') : JSON.stringify({
    translations: input.subtitles.map(line => ({ id: line.id, text: '译文：' + line.text }))
  });
  response.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const apiBase = `http://127.0.0.1:${server.address().port}/v1`;
const unique = Date.now().toString();
const testExtension = path.join(root, '.cache', 'extension-' + unique);
await cp(path.join(root, 'extension'), testExtension, { recursive: true });
const manifestPath = path.join(testExtension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
// Pregrant the mock API host in this test copy, avoiding native permission prompts.
manifest.host_permissions.push(new URL(apiBase).origin + '/*');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const systemChrome = process.env.YTAI_BROWSER_PATH || (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : null);
const context = await chromium.launchPersistentContext(path.join(root, '.cache', 'profile-' + unique), {
  ...(systemChrome ? { executablePath: systemChrome } : { channel: 'chromium' }),
  headless: true, viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
  args: systemChrome ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`]
});
if (systemChrome) {
  const devTools = await context.browser().newBrowserCDPSession();
  await devTools.send('Extensions.loadUnpacked', { path: testExtension });
  await devTools.detach();
}
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const report = [];
const check = async (name, run) => { await run(); report.push(name); console.log('PASS ' + name); };
let worker, id, options, videoPage, tabId;
const videoA = 'abcdefghijk', videoB = 'lmnopqrstuv', videoC = 'nopqrstuvwx';
const captions = (prefix = 'Video A') => JSON.stringify({ events: Array.from({ length: prefix.startsWith('Large batch') ? 120 : 24 }, (_, index) => ({
  tStartMs: index * 3000, dDurationMs: 2800,
  segs: [{ utf8: prefix === 'Merged screenshot' && index === 0 ? merged.source.text : `${prefix} sentence ${index}.` }]
})) });
const fixture = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Subtitle test video</title>
  <style>body{margin:0;background:#f4f5f6;font:14px Arial;color:#222}header{height:56px;background:white;padding:18px 24px;border-bottom:1px solid #ddd}
  main{margin:28px auto;max-width:1000px}#movie_player{position:relative;width:100%;aspect-ratio:16/9;background:#292b30;color:white;overflow:hidden}
  video{width:100%;height:100%}.visual{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#cdd6cf;font-size:26px}
  .ytp-caption-window-container{position:absolute;bottom:24px;left:20%;right:20%;text-align:center}.ytp-subtitles-button{position:absolute;bottom:8px;right:10px}h1{font-size:20px}</style></head>
  <body><header>YouTube / Subtitle integration fixture</header><main><div id="movie_player"><video></video><div class="visual">Subtitle integration test</div><div class="ytp-caption-window-container">Native caption</div><button class="ytp-subtitles-button" aria-pressed="true">CC</button></div><h1>Subtitle integration fixture</h1></main>
  <script>
  const video = document.querySelector('video');
  const sampleRate = 8000, samples = sampleRate * 90;
  const bytes = new ArrayBuffer(44 + samples * 2), wav = new DataView(bytes);
  const text = (offset, value) => { for (let index = 0; index < value.length; index++) wav.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); wav.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, sampleRate, true); wav.setUint32(28, sampleRate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
  text(36, 'data'); wav.setUint32(40, samples * 2, true);
  video.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); video.muted = true; video.playbackRate = .0625;
  window.fixture = {
    play() { return video.play(); },
    pause() { video.pause(); },
    seek(time) { video.currentTime = time; return new Promise(resolve => video.addEventListener('seeked', resolve, { once: true })); },
    async captions(id, prefix) { await fetch('/api/timedtext?v=' + id + '&lang=en&fmt=json3&name=' + encodeURIComponent(prefix)); },
    async navigate(id, prefix) { document.dispatchEvent(new Event('yt-navigate-start')); history.pushState({}, '', '/watch?v=' + id); video.currentTime = 0; window.playerInfo = {
      videoDetails: { videoId: id }, captions: { playerCaptionsTracklistRenderer: { captionTracks: prefix ? [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=' + id + '&lang=en&fmt=json3&name=' + encodeURIComponent(prefix), languageCode: 'en' }] : [] } }
    }; document.dispatchEvent(new Event('yt-navigate-finish')); if (prefix) await window.fixture.captions(id, prefix); }
  };
  window.playerInfo = { videoDetails: { videoId: '${videoA}' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=${videoA}&lang=en&fmt=json3&name=Video%20A', languageCode: 'en' }] } } };
  document.querySelector('#movie_player').getPlayerResponse = () => window.playerInfo;
  document.querySelector('.ytp-subtitles-button').onclick = event => event.currentTarget.setAttribute('aria-pressed', event.currentTarget.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  </script></body></html>`;
try {
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  id = new URL(worker.url()).host;
  options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await check('extension loads with no missing assets or worker errors', async () => {
    await expect(options.locator('#model')).toHaveValue('gpt-6.1-sol');
    await expect(options.locator('#configForm')).toHaveJSProperty('inert', false);
    await expect(options.locator('#save svg')).toHaveCount(1);
    assert.equal((await options.locator('.brand img').evaluate(image => image.naturalWidth)), 48);
  });
  await options.locator('#baseURL').fill(new URL(apiBase).origin);
  await options.locator('#apiKey').fill('mock-key-not-a-real-secret');
  await check('bare local URLs normalize to /v1 and model discovery selects an advertised text model', async () => {
    await options.locator('#loadModels').click();
    await expect(options.locator('#notice')).toContainText('已获取 1 个模型');
    await expect(options.locator('#baseURL')).toHaveValue(apiBase);
    await expect(options.locator('#model')).toHaveValue('mock-local-model');
    await expect(options.locator('#modelOptions option')).toHaveCount(1);
  });
  await options.locator('#prefetchSeconds').fill('15');
  await options.locator('#batchSize').fill('3');
  await options.locator('#save').click();
  await expect(options.locator('#notice')).toHaveText('配置已保存');
  await check('connection test uses the translation schema successfully', async () => {
    await options.locator('#test').click();
    await expect(options.locator('#notice')).toContainText('连接成功', { timeout: 30000 });
    assert.equal(api.bodies.at(-1).max_tokens, 1024);
    assert.equal(api.bodies.at(-1).reasoning_effort, undefined);
    assert.equal(api.bodies.at(-1).response_format.type, 'json_schema');
  });
  await check('API format can be overridden for a local OpenAI proxy', async () => {
    await options.locator('summary').click();
    await options.locator('#apiFormat').selectOption('openai');
    await options.locator('#test').click();
    await expect(options.locator('#notice')).toContainText('连接成功');
    assert.equal(api.bodies.at(-1).max_completion_tokens, 8192);
    assert.equal(api.bodies.at(-1).max_tokens, undefined);
    assert.equal(api.bodies.at(-1).reasoning_effort, 'low');
    await options.locator('#apiFormat').selectOption('auto');
    await options.locator('summary').click();
  });
  await check('slow local responses survive 30 seconds in the MV3 service worker', async () => {
    api.delay = 31000;
    try {
      await options.locator('#test').click();
      await expect(options.locator('#notice')).toContainText('连接成功', { timeout: 45000 });
    } finally { api.delay = 0; }
  });
  await check('settings layout fits desktop and narrow viewports', async () => {
    await options.locator('summary').click();
    await options.screenshot({ path: path.join(screenshots, 'settings-desktop.png'), fullPage: true });
    await options.setViewportSize({ width: 390, height: 844 });
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await options.screenshot({ path: path.join(screenshots, 'settings-mobile.png'), fullPage: true });
    await options.setViewportSize({ width: 1280, height: 900 });
    await options.locator('summary').click();
  });
  await context.route('https://www.youtube.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/watch') await route.fulfill({ body: fixture, contentType: 'text/html' });
    else if (url.pathname === '/api/timedtext') await route.fulfill({ body: captions(url.searchParams.get('name') || 'Video A'), contentType: 'application/json' });
    else await route.fulfill({ status: 204, body: '' });
  });
  videoPage = await context.newPage();
  await videoPage.goto(`https://www.youtube.com/watch?v=${videoA}`);
  tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, videoPage.url());
  const getStatus = () => worker.evaluate(async tab => chrome.tabs.sendMessage(tab, { type: 'GET_STATUS' }), tabId);
  await videoPage.evaluate(id => window.fixture.captions(id, 'Video A'), videoA);
  await check('captured captions work across MAIN and isolated worlds without API calls while paused', async () => {
    await expect.poll(async () => (await getStatus()).total).toBe(24);
    const before = api.calls.length;
    await videoPage.waitForTimeout(1200);
    assert.equal(api.calls.length, before);
    assert.equal((await getStatus()).ready, 0);
  });
  await check('normal pending translations keep the video status badge hidden', async () => {
    api.delay = 1300;
    try {
      await videoPage.evaluate(() => window.fixture.play());
      await expect.poll(async () => (await getStatus()).code).toBe('TRANSLATING');
      await expect(videoPage.locator('#ytai-root .badge')).toHaveText('');
      await expect(videoPage.locator('#ytai-root .badge')).toBeHidden();
      await expect(videoPage.locator('#ytai-root .translated')).toContainText('译文：Video A sentence 0.', { timeout: 10000 });
    } finally { api.delay = 0; }
  });
  await check('playing translates only the limited prefetch window and renders bilingual text', async () => {
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('译文：Video A sentence 0.', { timeout: 10000 });
    await expect.poll(async () => (await getStatus()).ready).toBe(6);
    await videoPage.waitForTimeout(1000);
    assert.equal((await getStatus()).ready, 6);
    assert.equal(await videoPage.locator('#movie_player').evaluate(player => player.classList.contains('ytai-hide-native')), true);
    await videoPage.screenshot({ path: path.join(screenshots, 'subtitles-desktop.png') });
  });
  await check('pause prevents further translation and seeking prioritizes the new position', async () => {
    await videoPage.evaluate(() => window.fixture.pause());
    const before = api.calls.length;
    await videoPage.evaluate(() => window.fixture.seek(54));
    await videoPage.waitForTimeout(1000);
    assert.equal(api.calls.length, before);
    await videoPage.evaluate(() => window.fixture.play());
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('Video A sentence 18.', { timeout: 10000 });
  });
  await check('disabled translation restores native captions immediately and reenabling resumes', async () => {
    await options.locator('#enabled').uncheck();
    await options.locator('#save').click();
    await expect.poll(async () => (await getStatus()).code).toBe('OFF');
    await expect(videoPage.locator('#movie_player')).not.toHaveClass(/ytai-hide-native/);
    assert.equal(await videoPage.locator('#ytai-root .original').textContent(), '');
    await options.locator('#enabled').check(); await options.locator('#save').click();
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('Video A sentence 18.');
  });
  await check('same-length caption replacement is accepted and output text is escaped', async () => {
    await videoPage.evaluate(id => window.fixture.captions(id, 'Replacement <img src=x onerror=alert(1)>'), videoA);
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('Replacement <img', { timeout: 10000 });
    assert.equal(await videoPage.locator('#ytai-root img').count(), 0);
  });
  await check('video navigation cancels stale work and starts the next video queue', async () => {
    api.delay = 1300;
    await videoPage.evaluate(async id => { window.fixture.seek(0); await window.fixture.captions(id, 'Delayed old video'); }, videoA);
    await expect.poll(() => api.calls.some(batch => batch.some(line => line.text.includes('Delayed old video')))).toBe(true);
    api.delay = 0;
    await videoPage.evaluate(id => window.fixture.navigate(id, 'Video B'), videoB);
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('Video B sentence 0.', { timeout: 10000 });
    await videoPage.evaluate(id => window.fixture.captions(id, 'Late old captions'), videoA);
    await videoPage.waitForTimeout(1700);
    assert.equal((await getStatus()).videoId, videoB);
    assert.ok((await videoPage.locator('#ytai-root .translated').textContent()).includes('Video B'));
  });
  await check('fatal API failure stops after one request, restores native captions, and manual retry recovers', async () => {
    api.status = 401;
    const before = api.calls.length;
    await videoPage.evaluate(id => window.fixture.captions(id, 'API failure'), videoB);
    await expect.poll(async () => (await getStatus()).code).toBe('ERROR');
    await videoPage.waitForTimeout(1700);
    assert.equal(api.calls.length, before + 1);
    await expect(videoPage.locator('#movie_player')).not.toHaveClass(/ytai-hide-native/);
    await expect(videoPage.locator('#ytai-root .badge')).toContainText('接口拒绝访问');
    await expect(videoPage.locator('#ytai-root .badge')).toHaveAttribute('data-error', 'true');
    await expect(videoPage.locator('#ytai-root .badge')).toBeVisible();
    api.status = 200;
    await worker.evaluate(async tab => chrome.tabs.sendMessage(tab, { type: 'RETRY_TRANSLATION' }), tabId);
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('API failure sentence 0.', { timeout: 10000 });
    await expect(videoPage.locator('#ytai-root .badge')).toBeHidden();
  });
  await check('fullscreen and narrow player layouts render without horizontal overflow', async () => {
    await videoPage.locator('#movie_player').click();
    await videoPage.evaluate(() => document.querySelector('#movie_player').requestFullscreen());
    await expect.poll(() => videoPage.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await videoPage.screenshot({ path: path.join(screenshots, 'subtitles-fullscreen.png') });
    await videoPage.evaluate(() => document.exitFullscreen());
    await videoPage.setViewportSize({ width: 390, height: 844 });
    assert.ok(await videoPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await videoPage.screenshot({ path: path.join(screenshots, 'subtitles-mobile.png') });
    await videoPage.setViewportSize({ width: 1280, height: 900 });
  });
  await check('long bilingual captions stay inside a narrow player', async () => {
    await videoPage.setViewportSize({ width: 390, height: 844 });
    await videoPage.evaluate(id => window.fixture.captions(id, 'Long subtitle with technical terms and detailed explanations '.repeat(3)), videoB);
    await expect(videoPage.locator('#ytai-root .translated')).toContainText('technical terms', { timeout: 10000 });
    const bounds = await videoPage.evaluate(() => {
      const player = document.querySelector('#movie_player').getBoundingClientRect();
      const captions = document.querySelector('#ytai-root').shadowRoot.querySelector('.captions').getBoundingClientRect();
      return { player: { top: player.top, bottom: player.bottom }, captions: { top: captions.top, bottom: captions.bottom } };
    });
    assert.ok(bounds.captions.top >= bounds.player.top);
    assert.ok(bounds.captions.bottom <= bounds.player.bottom);
    await videoPage.screenshot({ path: path.join(screenshots, 'subtitles-mobile-long.png') });
    await videoPage.setViewportSize({ width: 1280, height: 900 });
  });
  await check('popup displays current status and controls translation mode', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await worker.evaluate(async tab => chrome.tabs.update(tab, { active: true }), tabId);
    await popup.evaluate(() => load());
    await expect(popup.locator('#videoStatus')).toHaveText('字幕已就绪');
    await popup.locator('[name="viewMode"][value="translated"]').check();
    await expect(videoPage.locator('#ytai-root .original')).toHaveText('');
    await popup.locator('body').screenshot({ path: path.join(screenshots, 'popup.png') });
    await popup.close();
  });
  await check('display mode updates preserve newer API settings', async () => {
    const latest = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CONFIG' }));
    const beforeModel = latest.config.model;
    await options.evaluate(async cfg => chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: { ...cfg, model: 'newer-model' } }), latest.config);
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_VIEW_MODE', viewMode: 'original' }));
    const after = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CONFIG' }));
    assert.equal(after.config.model, 'newer-model');
    assert.equal(after.config.viewMode, 'original');
    await options.evaluate(async cfg => chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: cfg }), { ...latest.config, model: beforeModel });
  });
  await check('100-subtitle batches pass through settings, content script, worker and API without the old 10-line cap', async () => {
    await videoPage.evaluate(() => window.fixture.pause());
    await videoPage.evaluate(() => window.fixture.seek(0));
    await options.locator('#batchSize').fill('100');
    await options.locator('#prefetchSeconds').fill('600');
    await options.locator('#save').click();
    await expect(options.locator('#notice')).toHaveText('配置已保存');
    const saved = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CONFIG' }));
    assert.equal(saved.config.batchSize, 100);
    assert.equal(saved.config.prefetchSeconds, 600);
    const before = api.calls.length;
    await videoPage.evaluate(id => window.fixture.captions(id, 'Large batch'), videoB);
    await expect.poll(async () => (await getStatus()).total).toBe(120);
    await videoPage.evaluate(() => window.fixture.play());
    await expect.poll(() => api.calls.slice(before).map(batch => batch.length)).toEqual([100, 20]);
    await expect.poll(async () => (await getStatus()).ready).toBe(120);
    assert.equal(api.bodies[before].max_tokens, 12800);
  });
  await check('Hy-MT2 echoed instructions are retried by ID and never reach the overlay or cache', async () => {
    await videoPage.evaluate(() => window.fixture.pause());
    await videoPage.evaluate(() => window.fixture.seek(0));
    await options.locator('#model').fill('hy-mt2-7b');
    await options.locator('#batchSize').fill('3');
    await options.locator('#prefetchSeconds').fill('15');
    await options.locator('#save').click();
    await expect(options.locator('#notice')).toHaveText('配置已保存');
    api.hyEchoes = 1;
    const before = api.calls.length;
    await videoPage.evaluate(id => window.fixture.captions(id, 'Hy echo regression'), videoB);
    await expect.poll(async () => (await getStatus()).total).toBe(24);
    await videoPage.evaluate(() => window.fixture.play());
    await expect.poll(async () => (await getStatus()).ready).toBe(6);
    assert.deepEqual(api.calls[before].map(line => line.id), [0, 1, 2]);
    assert.deepEqual(api.calls[before + 1], [{ id: null, text: 'Hy echo regression sentence 1.' }]);
    assert.equal(api.bodies[before + 1].messages.length, 1);
    assert.doesNotMatch(api.bodies[before + 1].messages[0].content, /数字标记|参考信息/);
    const stored = await worker.evaluate(() => chrome.storage.local.get('translationCache'));
    assert.doesNotMatch(JSON.stringify(stored), /每个输入编号必须返回一行/);
    await videoPage.evaluate(() => window.fixture.pause());
    await videoPage.evaluate(() => window.fixture.seek(3.1));
    await expect(videoPage.locator('#ytai-root .translated')).toHaveText('译文：Hy echo regression sentence 1.');
    await expect(videoPage.locator('#ytai-root .badge')).toBeHidden();
    assert.equal((await getStatus()).error, null);
  });
  await check('the actual screenshot paragraph is rejected in batch and single retries and never rendered or cached', async () => {
    await videoPage.evaluate(() => window.fixture.seek(0));
    await videoPage.evaluate(() => {
      window.mergedObserved = [];
      const shadow = document.querySelector('#ytai-root').shadowRoot;
      window.mergedObserver = new MutationObserver(() => window.mergedObserved.push(shadow.querySelector('.translated').textContent));
      window.mergedObserver.observe(shadow.querySelector('.translated'), { childList: true, subtree: true, characterData: true });
    });
    api.hyMergedResponses = 2;
    const before = api.calls.length;
    await videoPage.evaluate(id => window.fixture.captions(id, 'Merged screenshot'), videoB);
    await expect.poll(async () => (await getStatus()).ready).toBe(0);
    await videoPage.evaluate(() => window.fixture.play());
    await expect.poll(async () => (await getStatus()).ready).toBe(6);
    assert.deepEqual(api.calls[before].map(line => line.id), [0, 1, 2]);
    assert.deepEqual(api.calls[before + 1], [{ id: null, text: merged.source.text }]);
    assert.deepEqual(api.calls[before + 2], [{ id: null, text: merged.source.text }]);
    assert.equal(api.hyMergedResponses, 0);
    assert.equal((await getStatus()).error, null);
    const observed = await videoPage.evaluate(() => { window.mergedObserver.disconnect(); return window.mergedObserved; });
    assert.doesNotMatch(JSON.stringify(observed), /Taran|补给线被切断/);
    await expect(videoPage.locator('#ytai-root .translated')).toHaveText('译文：' + merged.source.text);
    const stored = await worker.evaluate(() => chrome.storage.local.get('translationCache'));
    assert.equal(stored.translationCache.version, 5);
    assert.doesNotMatch(JSON.stringify(stored), /Taran|补给线被切断/);
    await expect(videoPage.locator('#ytai-root .badge')).toBeHidden();
    await videoPage.screenshot({ path: path.join(screenshots, 'subtitles-merged-regression.png') });
  });
  await check('videos without captions show a clear status and retain native caption ownership', async () => {
    await videoPage.evaluate(id => window.fixture.navigate(id, ''), videoC);
    await expect.poll(async () => (await getStatus()).code).toBe('NO_CAPTIONS');
    await expect(videoPage.locator('#movie_player')).not.toHaveClass(/ytai-hide-native/);
  });
  await check('API key remains local and public messages do not contain it', async () => {
    const publicData = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_PUBLIC_CONFIG' }));
    assert.equal(publicData.config.apiKey, undefined);
    assert.equal(publicData.config.hasApiKey, true);
    const sync = await worker.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(Object.keys(sync).length, 0);
  });
  await check('cache management clears translations without removing configuration', async () => {
    await options.locator('#clearCache').click();
    await expect(options.locator('#cacheStats')).toContainText('0 条译文');
    const configData = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_CONFIG' }));
    assert.equal(configData.config.apiKey, 'mock-key-not-a-real-secret');
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(screenshots, 'browser-results.json'), JSON.stringify({ passed: report, pageErrors: errors, mockApiCalls: api.calls.length }, null, 2));
  console.log(`Browser checks passed: ${report.length}; screenshots: ${screenshots}`);
} catch (failure) {
  if (worker && tabId) console.error('STATUS', await worker.evaluate(async tab => chrome.tabs.sendMessage(tab, { type: 'GET_STATUS' }), tabId).catch(() => null));
  if (videoPage) await videoPage.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
  console.error('PAGE ERRORS', errors);
  throw failure;
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
