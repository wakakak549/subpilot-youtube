import './lib/core.js';
import { ApiError, TranslationCache, TranslationService, requestChat, listModels } from './lib/translator.js';

const Core = globalThis.YTAICore;
const jobs = new Map();
const cache = new TranslationCache(chrome.storage.local);
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const trusted = sender => {
  try { return sender.url.startsWith(chrome.runtime.getURL('')); }
  catch { return false; }
};

async function getConfig() {
  await ready;
  const data = await chrome.storage.local.get('config');
  return Core.normalizeConfig(data.config || {});
}

async function permittedFetch(url, options) {
  const origin = new URL(url).origin + '/*';
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new ApiError('PERMISSION', '请在设置中保存接口配置并授权访问');
  // Local generation and large batches can exceed the service worker's idle timeout.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try { return await fetch(url, options); }
  finally { clearInterval(keepAlive); }
}
const service = new TranslationService(cache, { fetcher: permittedFetch });

function abortJobs(tabId, sessionId) {
  for (const [key, job] of jobs) {
    if ((tabId === undefined || job.tabId === tabId) && (!sessionId || job.sessionId === sessionId)) {
      job.controller.abort();
      jobs.delete(key);
    }
  }
}

async function broadcastConfig(cfg) {
  abortJobs();
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_CHANGED', config: Core.publicConfig(cfg) })));
}

function validateTranslation(message, sender) {
  // sender.url can retain the original document URL after YouTube SPA navigation.
  if (!sender.tab?.id || Core.getVideoId(sender.tab.url || sender.url) !== message.videoId) throw new ApiError('INVALID', '字幕请求来自无效视频');
  if (typeof message.sessionId !== 'string' || message.sessionId.length > 80 || typeof message.trackId !== 'string' || message.trackId.length > 256) throw new ApiError('INVALID', '字幕会话无效');
  if (!Array.isArray(message.lines) || !message.lines.length || message.lines.length > Core.MAX_BATCH_SIZE) throw new ApiError('INVALID', '字幕批量大小无效');
  const ids = new Set();
  for (const line of message.lines) {
    if (!Number.isInteger(line.id) || line.id < 0 || ids.has(line.id) || typeof line.text !== 'string' || line.text.length > 3000 || !line.text.trim()) throw new ApiError('INVALID', '字幕内容无效');
    ids.add(line.id);
  }
  for (const field of ['context_before', 'context_after']) {
    if (!Array.isArray(message[field]) || message[field].length > 3 || message[field].some(text => typeof text !== 'string' || text.length > 3000)) throw new ApiError('INVALID', '字幕上下文无效');
  }
}

async function handle(message, sender) {
  await ready;
  if (!message || typeof message.type !== 'string') throw new ApiError('INVALID', '无效请求');
  if (message.type === 'GET_PUBLIC_CONFIG') return { config: Core.publicConfig(await getConfig()) };
  if (message.type === 'CANCEL_SESSION') {
    if (sender.tab?.id) abortJobs(sender.tab.id, message.sessionId);
    return { ok: true };
  }
  if (message.type === 'TRANSLATE_BATCH') {
    validateTranslation(message, sender);
    const cfg = await getConfig();
    if (!cfg.enabled || cfg.viewMode === 'original') return { translations: [], error: { code: 'CANCELLED', message: '翻译已关闭' } };
    const key = sender.tab.id + ':' + message.sessionId;
    if (jobs.has(key)) throw new ApiError('BUSY', '当前字幕仍在翻译');
    const controller = new AbortController();
    const job = { tabId: sender.tab.id, sessionId: message.sessionId, controller };
    jobs.set(key, job);
    try { return await service.translate(cfg, message, controller.signal); }
    finally { if (jobs.get(key) === job) jobs.delete(key); }
  }
  if (!trusted(sender)) throw new ApiError('INVALID', '此操作仅限插件设置页面');
  if (message.type === 'GET_CONFIG') return { config: await getConfig() };
  if (['SAVE_CONFIG', 'SET_ENABLED', 'SET_VIEW_MODE'].includes(message.type)) {
    const input = message.type === 'SAVE_CONFIG' ? message.config : {
      ...await getConfig(), ...(message.type === 'SET_ENABLED' ? { enabled: Boolean(message.enabled) } : { viewMode: message.viewMode })
    };
    const cfg = Core.normalizeConfig(input);
    await chrome.storage.local.set({ config: cfg });
    await broadcastConfig(cfg);
    return { ok: true, config: Core.publicConfig(cfg) };
  }
  if (message.type === 'TEST_CONNECTION') {
    const cfg = Core.normalizeConfig(message.config);
    const result = await requestChat(cfg, [{ id: 0, text: 'Hello, world.' }], [], [], null, permittedFetch);
    if (result.missing.length) throw new ApiError('FORMAT', '接口已响应，但译文格式不完整');
    return { ok: true, sample: result.translations[0].text };
  }
  if (message.type === 'LIST_MODELS') return { models: await listModels(Core.normalizeConfig(message.config), permittedFetch) };
  if (message.type === 'CACHE_STATS') return { stats: await cache.stats() };
  if (message.type === 'CLEAR_CACHE') { abortJobs(); await cache.clear(); return { ok: true, stats: await cache.stats() }; }
  if (message.type === 'RETRY_TAB') {
    await chrome.tabs.sendMessage(message.tabId, { type: 'RETRY_TRANSLATION' });
    return { ok: true };
  }
  throw new ApiError('INVALID', '未知请求');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse).catch(error => sendResponse({
    error: { code: error.code || 'INTERNAL', message: error.code ? error.message : '插件处理失败，请重新加载插件' }
  }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => abortJobs(tabId));
