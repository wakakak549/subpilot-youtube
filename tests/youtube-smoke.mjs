import { chromium } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
let apiCalls = 0;
const server = http.createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  apiCalls++;
  const input = JSON.parse(JSON.parse(raw).messages[1].content);
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    translations: input.subtitles.map(line => ({ id: line.id, text: '模拟译文：' + line.text }))
  }) } }] }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const apiBase = `http://127.0.0.1:${server.address().port}/v1`;
const unique = Date.now().toString();
const extension = path.join(root, '.cache', 'live-extension-' + unique);
await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifestFile = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
manifest.host_permissions.push(new URL(apiBase).origin + '/*');
await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
const context = await chromium.launchPersistentContext(path.join(root, '.cache', 'live-profile-' + unique), {
  executablePath: process.env.YTAI_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, viewport: { width: 1440, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'], ignoreHTTPSErrors: true
});
const targetVideo = process.argv[2] || 'arj7oStGLkU';
const report = { url: `https://www.youtube.com/watch?v=${targetVideo}`, api: 'local mock only', samples: [], captionResponses: [], transcriptResponses: [] };
try {
  const devTools = await context.browser().newBrowserCDPSession();
  await devTools.send('Extensions.loadUnpacked', { path: extension }); await devTools.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async baseURL => chrome.storage.local.set({ config: {
    baseURL, model: 'gpt-6.1-sol', apiKey: '', enabled: true, targetLang: '简体中文',
    prefetchSeconds: 15, batchSize: 3, reasoningEffort: 'low', structuredOutput: true
  } }), apiBase);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.pathname.includes('/get_transcript')) {
      try {
        const body = await response.text();
        report.transcriptResponses.push({ status: response.status(), length: body.length, hasSegments: body.includes('transcriptSegmentRenderer') });
        await writeFile(path.join(artifacts, 'transcript-sample.json'), body);
      } catch {}
      return;
    }
    if (url.pathname !== '/api/timedtext') return;
    try {
      const body = await response.text();
      report.captionResponses.push({ status: response.status(), lang: url.searchParams.get('lang'), kind: url.searchParams.get('kind'), format: url.searchParams.get('fmt'), length: body.length });
    } catch {}
  });
  await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const rejectCookies = page.locator('ytd-consent-bump-v2-lightbox').getByText(/^(Reject all|拒绝全部|全部拒绝)$/i);
  if (await rejectCookies.count()) await rejectCookies.first().click({ timeout: 5000 });
  for (let index = 0; index < 6; index++) {
    await page.waitForTimeout(5000);
    if (await rejectCookies.count() && await rejectCookies.first().isVisible()) await rejectCookies.first().click({ timeout: 5000 });
    if (index === 0) await page.evaluate(() => {
      const player = document.querySelector('#movie_player');
      const data = player?.getPlayerResponse?.();
      const track = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.find(track => track.languageCode === 'en' && track.kind !== 'asr');
      if (track) player.setOption('captions', 'track', track);
    });
    if (index === 2) {
      const expand = page.locator('ytd-watch-metadata #description #expand');
      if (await expand.count()) await expand.first().click();
      const transcript = page.getByRole('button', { name: /Show transcript|显示文字记录|显示转录稿|显示文稿/i });
      report.transcriptButtons = await transcript.count();
      if (report.transcriptButtons) await transcript.first().click();
      const direct = await page.evaluate(async () => {
        const find = value => {
          if (!value || typeof value !== 'object') return null;
          if (value.getTranscriptEndpoint?.params) return value.getTranscriptEndpoint;
          for (const child of Object.values(value)) { const endpoint = find(child); if (endpoint) return endpoint; }
          return null;
        };
        const endpoint = find(window.ytInitialData);
        if (!endpoint) return { available: false };
        const response = await fetch('/youtubei/v1/get_transcript', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: window.ytcfg.get('INNERTUBE_CONTEXT'), params: endpoint.params })
        });
        const body = await response.text();
        return { available: true, status: response.status, length: body.length, hasSegments: body.includes('transcriptSegmentRenderer') };
      });
      report.directTranscript = direct;
      console.log('DIRECT TRANSCRIPT', JSON.stringify(direct));
    }
    await page.evaluate(() => { const video = document.querySelector('video'); if (video) { video.muted = true; video.play().catch(() => {}); } });
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, report.url);
    const status = await worker.evaluate(async tabId => chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' }), tab);
    const player = await page.evaluate(() => {
      const element = document.querySelector('#movie_player');
      const data = element?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      return {
        title: document.title,
        availability: data?.playabilityStatus?.status,
        reason: data?.playabilityStatus?.reason,
        captionLanguages: data?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.map(track => track.languageCode),
        videoTime: document.querySelector('video')?.currentTime,
        paused: document.querySelector('video')?.paused,
        playbackRate: document.querySelector('video')?.playbackRate,
        readyState: document.querySelector('video')?.readyState,
        mediaError: document.querySelector('video')?.error?.message,
        transcriptSegments: document.querySelectorAll('ytd-transcript-segment-renderer').length,
        captionsOn: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
        nativeCaption: document.querySelector('.ytp-caption-segment')?.textContent,
        ad: element?.classList.contains('ad-showing'),
        original: document.querySelector('#ytai-root')?.shadowRoot?.querySelector('.original')?.textContent,
        translated: document.querySelector('#ytai-root')?.shadowRoot?.querySelector('.translated')?.textContent
      };
    });
    report.samples.push({ status, player });
    console.log(JSON.stringify({ status, player, captionResponses: report.captionResponses, transcripts: report.transcriptResponses }));
    if (status.ready > 0 || player.availability === 'LOGIN_REQUIRED' || status.code === 'ERROR') break;
  }
  report.mockApiCalls = apiCalls;
  report.result = report.samples.some(sample => sample.status.ready > 0) ? 'captions acquired and translated via mock API' : 'no translated captions; inspect samples';
  report.pageErrors = errors;
  await page.screenshot({ path: path.join(artifacts, 'youtube-live.png') });
  await writeFile(path.join(artifacts, 'youtube-live-results.json'), JSON.stringify(report, null, 2));
  console.log(report.result);
} catch (error) {
  report.result = 'environment or page load failed'; report.error = error.message;
  await writeFile(path.join(artifacts, 'youtube-live-results.json'), JSON.stringify(report, null, 2));
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
