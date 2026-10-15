(function () {
  'use strict';
  const Core = globalThis.YTAICore;
  let config = null;
  let videoId = null, generation = 0, requestVersion = 0;
  let sessionId = crypto.randomUUID();
  let cues = [], trackId = '', fingerprint = '', tracks = [];
  let pending = false, error = null, isLive = false, playerDataReceived = false;
  let player = null, video = null, root = null, shadow = null;
  let originalEl = null, translatedEl = null, badgeEl = null;
  let captionsEl = null, lastLayout = '';
  let captionSequence = 0, parseVersion = 0, bufferedCaption = null;
  let startedAt = 0, ccTried = false, requests = 0, cacheHits = 0;
  let fallbackController = new AbortController();
  let fallbackURL = null, fallbackTimer = null;
  const triedURLs = new Set();
  const labels = {
    IDLE: '打开 YouTube 视频', OFF: '翻译已关闭', WAITING: '等待字幕', NO_CAPTIONS: '没有可用字幕',
    LIVE: '暂不支持直播字幕', CONFIG: '待配置翻译接口', TRANSLATING: '正在翻译', PAUSED: '已暂停',
    READY: '字幕已就绪', ERROR: '翻译暂停', CC_OFF: '字幕未开启', ORIGINAL: '显示原文', AD: '广告播放中', CAPTION_ERROR: '字幕暂时无法读取'
  };

  function send(message) { return chrome.runtime.sendMessage(message); }
  function invalidateRequest() {
    send({ type: 'CANCEL_SESSION', sessionId }).catch(() => {});
    requestVersion++;
    sessionId = crypto.randomUUID();
    pending = false;
  }
  function captionsOn() {
    return document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') !== 'false';
  }
  function state() {
    let code;
    if (!videoId) code = 'IDLE';
    else if (!config?.enabled) code = 'OFF';
    else if (player?.classList.contains('ad-showing')) code = 'AD';
    else if (isLive) code = 'LIVE';
    else if (error) code = 'ERROR';
    else if (config.viewMode === 'original' && cues.length) code = 'ORIGINAL';
    else if (config.viewMode !== 'original' && (!config.model || (!config.hasApiKey && new URL(config.baseURL).hostname === 'api.openai.com'))) code = 'CONFIG';
    else if (!cues.length && tracks.length && Date.now() - startedAt > 25000) code = 'CAPTION_ERROR';
    else if (!cues.length) code = tracks.length === 0 && (playerDataReceived || Date.now() - startedAt > 15000) ? 'NO_CAPTIONS' : 'WAITING';
    else if (!captionsOn()) code = 'CC_OFF';
    else if (pending) code = 'TRANSLATING';
    else if (video?.paused) code = 'PAUSED';
    else code = 'READY';
    return {
      code, label: labels[code], videoId, error,
      ready: cues.filter(cue => cue.translated).length, total: cues.length,
      requests, cacheHits, sourceLang: tracks.find(track => Core.trackKey(new URL(track.baseUrl)) === trackId.split(':')[0])?.languageCode || '',
      enabled: Boolean(config?.enabled)
    };
  }

  function resetRoute(nextId) {
    generation++;
    parseVersion++;
    invalidateRequest();
    fallbackController.abort();
    fallbackController = new AbortController();
    clearTimeout(fallbackTimer);
    triedURLs.clear();
    videoId = nextId;
    cues = []; tracks = []; trackId = ''; fingerprint = ''; error = null; isLive = false; playerDataReceived = false;
    captionSequence = 0; fallbackURL = null; bufferedCaption = null;
    startedAt = Date.now(); ccTried = false; requests = 0; cacheHits = 0;
    restoreNative();
    bindPlayer();
    render();
    if (nextId) requestPlayerData();
  }

  function syncRoute() {
    const nextId = Core.getVideoId(location.href);
    if (nextId !== videoId) resetRoute(nextId);
    bindPlayer();
  }

  function restoreNative() {
    player?.classList.remove('ytai-hide-native');
    if (originalEl) originalEl.textContent = '';
    if (translatedEl) translatedEl.textContent = '';
  }

  function bindPlayer() {
    const nextPlayer = videoId ? document.querySelector('#movie_player') : null;
    const nextVideo = nextPlayer?.querySelector('video');
    if (player !== nextPlayer) {
      restoreNative(); root?.remove();
      player = nextPlayer;
      root = null;
      if (player) createOverlay();
    }
    if (video !== nextVideo) {
      if (video) {
        for (const name of ['timeupdate', 'play', 'pause', 'seeked', 'seeking']) video.removeEventListener(name, onVideoEvent);
      }
      video = nextVideo;
      if (video) {
        for (const name of ['timeupdate', 'play', 'pause', 'seeked', 'seeking']) video.addEventListener(name, onVideoEvent);
      }
    }
    if (player && root && !player.contains(root)) player.appendChild(root);
  }

  function createOverlay() {
    root = document.createElement('div');
    root.id = 'ytai-root';
    shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; font-family: Arial, "Microsoft YaHei", sans-serif; pointer-events: none; }
      * { box-sizing: border-box; letter-spacing: 0; }
      .captions { position: absolute; left: 4%; right: 4%; bottom: 64px; text-align: center; }
      .line { width: fit-content; max-width: 100%; margin: 3px auto; padding: 3px 9px; border-radius: 3px;
        white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.4; font-weight: 500;
        color: #fff; background: rgba(0,0,0,.78); text-shadow: 0 1px 2px #000; }
      .line:empty { display: none; }
      .translated { color: #fff09a; }
      .badge { position: absolute; top: 48px; right: 12px; max-width: min(290px, 85%); padding: 5px 9px;
        font-size: 12px; line-height: 1.4; color: #fff; background: rgba(24,24,24,.88); border-radius: 3px; overflow-wrap: anywhere; }
      .badge:empty { display: none; }
      .badge[data-error="true"] { background: rgba(153,32,32,.94); }
    `;
    const captions = document.createElement('div'); captions.className = 'captions';
    captionsEl = captions; lastLayout = '';
    originalEl = document.createElement('div'); originalEl.className = 'line original';
    translatedEl = document.createElement('div'); translatedEl.className = 'line translated';
    badgeEl = document.createElement('div'); badgeEl.className = 'badge';
    captions.append(originalEl, translatedEl);
    shadow.append(style, captions, badgeEl);
    player.appendChild(root);
  }

  function render() {
    if (!player || !originalEl || !config) return;
    const currentState = state();
    const blocked = !config.enabled || !videoId || isLive || !captionsOn() || player.classList.contains('ad-showing');
    const index = Core.activeIndex(cues, (video?.currentTime || 0) * 1000);
    const cue = cues[index];
    const ready = cue?.translated;
    const canShow = !blocked && cue && (config.viewMode === 'original' ||
      (config.viewMode === 'bilingual' && (!error || ready) && currentState.code !== 'CONFIG') ||
      (config.viewMode === 'translated' && ready));
    player.classList.toggle('ytai-hide-native', Boolean(canShow));
    const original = canShow && config.viewMode !== 'translated' ? cue.text : '';
    const translated = canShow && config.viewMode !== 'original' ? cue.translated || '' : '';
    if (originalEl.textContent !== original) originalEl.textContent = original;
    if (translatedEl.textContent !== translated) translatedEl.textContent = translated;
    fitCaptions(original, translated);
    const badge = blocked || ['READY', 'PAUSED', 'ORIGINAL', 'CC_OFF', 'TRANSLATING'].includes(currentState.code) ? '' :
      error?.message || currentState.label;
    if (badgeEl.textContent !== badge) badgeEl.textContent = badge;
    badgeEl.dataset.error = String(Boolean(error));
  }

  function fitCaptions(original, translated) {
    const fullscreen = Boolean(document.fullscreenElement);
    const layout = JSON.stringify([original, translated, config.originalFont, config.translatedFont, player.clientWidth, player.clientHeight, fullscreen]);
    if (layout === lastLayout) return;
    lastLayout = layout;
    const bottom = Math.min(64, Math.max(28, Math.round(player.clientHeight * .08)));
    const available = Math.max(35, player.clientHeight - bottom - 20);
    captionsEl.style.bottom = bottom + 'px';
    let originalSize = config.originalFont + (fullscreen ? 4 : 0);
    let translatedSize = config.translatedFont + (fullscreen ? 4 : 0);
    originalEl.style.fontSize = originalSize + 'px';
    translatedEl.style.fontSize = translatedSize + 'px';
    while (captionsEl.scrollHeight > available && (originalSize > 12 || translatedSize > 12)) {
      originalSize = Math.max(12, originalSize - 1); translatedSize = Math.max(12, translatedSize - 1);
      originalEl.style.fontSize = originalSize + 'px'; translatedEl.style.fontSize = translatedSize + 'px';
    }
    captionsEl.style.maxHeight = available + 'px';
    captionsEl.style.overflow = 'hidden';
  }

  async function acceptCaptions(data, fallback = false) {
    syncRoute();
    const url = Core.captionURL(data.url, videoId);
    if (!url || typeof data.body !== 'string' || data.body.length > Core.MAX_BODY_SIZE || isLive) return;
    if (fallback && cues.length) return;
    const sequence = Number(data.sequence) || 0;
    if (!fallback && sequence < captionSequence) return;
    if (!fallback) captionSequence = sequence;
    if (!config) { bufferedCaption = data; return; }
    if (!config.enabled) return;
    const sourceGeneration = generation;
    const parsing = ++parseVersion;
    const parsed = Core.groupCues(Core.parseCaptions(data.body));
    if (!parsed.length) return;
    const hash = await Core.digest(JSON.stringify(parsed));
    if (sourceGeneration !== generation || parsing !== parseVersion || Core.getVideoId(location.href) !== videoId || !config.enabled) return;
    const nextTrack = Core.trackKey(url).slice(0, 128) + ':' + hash;
    if (fingerprint === nextTrack) return;
    invalidateRequest();
    cues = parsed; trackId = nextTrack; fingerprint = nextTrack; error = null;
    clearTimeout(fallbackTimer);
    render();
    pump();
  }

  function requestPlayerData() {
    window.postMessage({ channel: Core.CHANNEL, type: 'REQUEST_PLAYER_DATA' }, location.origin);
  }

  function scheduleFallback(value) {
    if (!videoId || !config?.enabled || cues.length || !Core.captionURL(value, videoId) || triedURLs.has(value)) return;
    if (value === fallbackURL && fallbackTimer) return;
    fallbackURL = value;
    clearTimeout(fallbackTimer);
    const epoch = generation;
    fallbackTimer = setTimeout(async () => {
      fallbackTimer = null;
      if (epoch !== generation || cues.length || !config.enabled || triedURLs.has(value)) return;
      triedURLs.add(value);
      try {
        const signal = fallbackController.signal;
        const response = await fetch(value, { credentials: 'include', signal });
        if (!response.ok || signal.aborted || epoch !== generation) return;
        const body = await response.text();
        if (!signal.aborted && epoch === generation) await acceptCaptions({ url: value, body }, true);
      } catch { /* Native captions remain available if the fallback request fails. */ }
    }, 900);
  }

  function maybeEnableCC() {
    if (!videoId || !config?.enabled || isLive || cues.length || ccTried || !tracks.length || Date.now() - startedAt < 3500) return;
    const button = document.querySelector('.ytp-subtitles-button');
    if (!button) return;
    ccTried = true;
    if (button.getAttribute('aria-pressed') === 'false') button.click();
  }

  async function pump() {
    syncRoute();
    if (!config?.enabled || !videoId || !video || video.paused || video.seeking || !captionsOn() || isLive || player?.classList.contains('ad-showing') || pending || error || config.viewMode === 'original') return;
    if (!config.model || (!config.hasApiKey && new URL(config.baseURL).hostname === 'api.openai.com')) { render(); return; }
    const batch = Core.pickBatch(cues, video.currentTime * 1000, config);
    if (!batch) return;
    const epoch = requestVersion;
    const sourceGeneration = generation;
    const sourceTrack = trackId;
    pending = true;
    render();
    try {
      const response = await send({ type: 'TRANSLATE_BATCH', sessionId, videoId, trackId, ...batch });
      if (epoch !== requestVersion || sourceGeneration !== generation || sourceTrack !== trackId || Core.getVideoId(location.href) !== videoId || !config.enabled) return;
      for (const line of response?.translations || []) {
        const text = typeof line.text === 'string' ? Core.cleanTranslationText(line.text, line.id) : '';
        if (cues[line.id] && Core.isTranslationPlausible(text, cues[line.id].text)) cues[line.id].translated = text;
      }
      requests += response?.requests || 0;
      cacheHits += response?.cached || 0;
      if (response?.error && response.error.code !== 'CANCELLED') error = response.error;
      if (!response || (!response.error && !(response.translations?.length))) error = { code: 'FORMAT', message: '未取得译文，翻译已暂停' };
    } catch {
      if (epoch === requestVersion) error = { code: 'DISCONNECTED', message: '插件连接中断' };
    } finally {
      if (epoch === requestVersion) { pending = false; render(); }
    }
  }

  function onVideoEvent(event) {
    syncRoute();
    if (event.type === 'seeking') invalidateRequest();
    render();
    if (event.type === 'play' || event.type === 'seeked') pump();
  }

  function applyConfig(next) {
    const changed = config && ['baseURL', 'model', 'apiFormat', 'targetLang', 'reasoningEffort', 'structuredOutput'].some(key => config[key] !== next[key]);
    config = next;
    invalidateRequest();
    error = null;
    if (changed) for (const cue of cues) delete cue.translated;
    if (!config.enabled) restoreNative();
    else {
      if (bufferedCaption) { const data = bufferedCaption; bufferedCaption = null; acceptCaptions(data); }
      requestPlayerData();
      if (fallbackURL && !cues.length) { triedURLs.delete(fallbackURL); scheduleFallback(fallbackURL); }
      pump();
    }
    render();
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== Core.CHANNEL) return;
    const data = event.data;
    if (data.type === 'CAPTIONS') acceptCaptions(data);
    else if (data.type === 'PLAYER_DATA') {
      syncRoute();
      if (!videoId || data.videoId !== videoId || !Array.isArray(data.tracks)) return;
      tracks = data.tracks.filter(track => track && Core.captionURL(track.baseUrl, videoId)).slice(0, 100);
      playerDataReceived = true;
      isLive = Boolean(data.isLive);
      if (isLive) invalidateRequest();
      else if (!cues.length && tracks.length && Core.captionURL(data.preferredURL, videoId)) scheduleFallback(data.preferredURL);
      render();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'GET_STATUS') { syncRoute(); respond(state()); }
    else if (message?.type === 'CONFIG_CHANGED') { applyConfig(message.config); respond({ ok: true }); }
    else if (message?.type === 'RETRY_TRANSLATION') {
      error = null; startedAt = Date.now(); triedURLs.clear(); ccTried = false;
      invalidateRequest(); requestPlayerData();
      if (fallbackURL && !cues.length) scheduleFallback(fallbackURL);
      pump(); render(); respond({ ok: true });
    }
  });
  document.addEventListener('yt-navigate-start', () => { invalidateRequest(); restoreNative(); });
  document.addEventListener('yt-navigate-finish', () => { syncRoute(); requestPlayerData(); render(); });
  document.addEventListener('fullscreenchange', render);
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.name.includes('/api/timedtext')) scheduleFallback(entry.name);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch { /* Captured response messages remain the primary caption path. */ }

  send({ type: 'GET_PUBLIC_CONFIG' }).then(response => {
    if (response?.config) { syncRoute(); applyConfig(response.config); }
  }).catch(() => { error = { code: 'DISCONNECTED', message: '插件连接中断' }; render(); });
  setInterval(() => { syncRoute(); maybeEnableCC(); render(); pump(); }, 750);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncRoute, { once: true });
  else syncRoute();
})();
