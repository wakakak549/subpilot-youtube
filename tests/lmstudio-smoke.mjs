import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../extension/lib/core.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const Core = globalThis.YTAICore;
const baseURL = Core.normalizeBaseURL(process.env.YTAI_LOCAL_API || 'http://localhost:1234');
assert.ok(Core.isLocalAPI(baseURL), 'This smoke check only connects to a loopback API');
const inventory = await (await fetch(new URL('/api/v0/models', baseURL))).json();
const loaded = inventory.data.filter(model => model.type === 'llm' && model.state === 'loaded');
const model = process.env.YTAI_LOCAL_MODEL || loaded[0]?.id;
assert.ok(loaded.some(item => item.id === model), 'Load a text model in LM Studio before running this check');

const folder = path.join(root, '.cache', 'lmstudio-' + Date.now());
const extension = path.join(folder, 'extension');
await mkdir(folder, { recursive: true });
await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions.push(new URL(baseURL).origin + '/*');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const systemChrome = process.env.YTAI_BROWSER_PATH || (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : null);
const context = await chromium.launchPersistentContext(path.join(folder, 'profile'), {
  ...(systemChrome ? { executablePath: systemChrome } : { channel: 'chromium' }),
  headless: true, viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
  args: systemChrome ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  if (systemChrome) {
    const session = await context.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: extension });
    await session.detach();
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('#model')).toHaveValue(Core.DEFAULTS.model);
  await expect(page.locator('#configForm')).toHaveJSProperty('inert', false);
  await page.locator('#baseURL').fill(new URL(baseURL).origin);
  await page.locator('#loadModels').click();
  await expect(page.locator('#notice')).toContainText('已获取', { timeout: 20000 });
  await expect(page.locator('#baseURL')).toHaveValue(baseURL);
  await page.locator('#model').fill(model);
  await page.locator('#batchSize').fill('100');
  await page.locator('#prefetchSeconds').fill('300');
  await page.locator('#save').click();
  await expect(page.locator('#notice')).toHaveText('配置已保存');
  await page.locator('#test').click();
  await expect(page.locator('#notice')).toContainText('连接成功', { timeout: 30000 });
  await page.locator('summary').click();
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'lmstudio-connection.png'), fullPage: true });
  const result = {
    browser: systemChrome ? 'Chrome' : 'Chromium', version: manifest.version, baseURL, model,
    modelCount: await page.locator('#modelOptions option').count(),
    notice: await page.locator('#notice').innerText(), pageErrors: errors
  };
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'lmstudio-browser-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await context.close(); }
