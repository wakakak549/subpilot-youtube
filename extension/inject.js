(function () {
  'use strict';
  if (window.__ytaiInstalled) return;
  window.__ytaiInstalled = true;
  const CHANNEL = 'youtube-ai-subtitles-v1';
  const MAX_BODY_SIZE = 8 * 1024 * 1024;
  const post = data => window.postMessage({ channel: CHANNEL, ...data }, location.origin);
  const classify = value => {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== 'https://www.youtube.com') return null;
      return url.pathname === '/api/timedtext' ? 'captions' : url.pathname === '/youtubei/v1/player' ? 'player' : null;
    } catch { return null; }
  };
  function playerData(response) {
    try {
      const data = typeof response === 'string' ? JSON.parse(response) : response;
      const videoId = data?.videoDetails?.videoId;
      if (!videoId) return;
      const renderer = data.captions?.playerCaptionsTracklistRenderer;
      const tracks = (renderer?.captionTracks || []).map(track => ({
        baseUrl: track.baseUrl, languageCode: track.languageCode, kind: track.kind || '',
        name: track.name?.simpleText || track.name?.runs?.map(run => run.text).join('') || ''
      }));
      let selectedTrack;
      try { selectedTrack = document.getElementById('movie_player')?.getOption?.('captions', 'track'); } catch {}
      const defaultIndex = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex || 0]?.defaultCaptionTrackIndex;
      const preferred = tracks.find(track => track.languageCode === selectedTrack?.languageCode && track.kind === (selectedTrack.kind || '')) || tracks[defaultIndex];
      post({ type: 'PLAYER_DATA', videoId, tracks, preferredURL: preferred?.baseUrl || '', isLive: Boolean(data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow) });
    } catch { /* Player responses may be absent during navigation. */ }
  }
  let captionSequence = 0;
  function publishCaptions(url, body, sequence) {
    if (typeof body === 'string' && body.length && body.length <= MAX_BODY_SIZE) post({ type: 'CAPTIONS', url, body, sequence });
  }
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url || String(input || '');
    const type = classify(url);
    const sequence = type === 'captions' ? ++captionSequence : 0;
    const response = await originalFetch.apply(this, args);
    if (response.ok && type) {
      try {
        const clone = response.clone();
        if (type === 'captions') clone.text().then(body => publishCaptions(new URL(url, location.href).href, body, sequence)).catch(() => {});
        else clone.json().then(playerData).catch(() => {});
      } catch { /* Keep the original request unaffected if its body cannot be cloned. */ }
    }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytaiURL = String(url);
    this.__ytaiSequence = classify(url) === 'captions' ? ++captionSequence : 0;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__ytaiURL;
    const type = classify(url);
    if (type) this.addEventListener('load', () => {
      if (this.status < 200 || this.status >= 300) return;
      try {
        if (type === 'captions') publishCaptions(new URL(url, location.href).href, this.responseText, this.__ytaiSequence);
        else playerData(this.responseType === 'json' ? this.response : this.responseText);
      } catch { /* Unsupported XHR response types are ignored. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
  function scanPlayer() {
    try {
      const response = document.getElementById('movie_player')?.getPlayerResponse?.();
      if (response) { playerData(response); return; }
    } catch { /* Fall back to the initial response while the player initializes. */ }
    playerData(window.ytInitialPlayerResponse);
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === CHANNEL && event.data.type === 'REQUEST_PLAYER_DATA') scanPlayer();
  });
  document.addEventListener('yt-navigate-finish', scanPlayer);
  let count = 0;
  const timer = setInterval(() => { scanPlayer(); if (++count >= 40) clearInterval(timer); }, 250);
})();
