(function () {
  'use strict';
  const DEFAULTS = Object.freeze({
    enabled: true,
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-6.1-sol',
    apiFormat: 'auto',
    targetLang: '简体中文',
    reasoningEffort: 'low',
    structuredOutput: true,
    requestTimeoutSeconds: 120,
    viewMode: 'bilingual',
    prefetchSeconds: 45,
    batchSize: 6,
    originalFont: 18,
    translatedFont: 22
  });
  const CHANNEL = 'youtube-ai-subtitles-v1';
  const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
  const MAX_BODY_SIZE = 8 * 1024 * 1024;
  const MAX_BATCH_SIZE = 100;
  const MAX_PREFETCH_SECONDS = 600;
  const TERMINAL = /[.!?。！？…][\s)"'』」]*$/;

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }

  function isLocalAPI(value) {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  }

  function isHyMTModel(model) {
    return /(?:^|[\/_-])hy[-_]?mt2(?:[\/_-]|$)/i.test(String(model || ''));
  }

  function isCompatibleAPI(cfg) {
    return cfg.apiFormat === 'compatible' || (cfg.apiFormat === 'auto' && isLocalAPI(cfg.baseURL));
  }

  function normalizeBaseURL(value, apiFormat = 'auto') {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('接口地址必须是无账号、查询参数的 HTTP 或 HTTPS 地址');
    }
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    url.pathname = pathname || (isCompatibleAPI({ baseURL: url.href, apiFormat }) ? '/v1' : '/');
    return url.href.replace(/\/+$/, '');
  }

  function normalizeConfig(input = {}) {
    const cfg = { ...DEFAULTS, ...input };
    cfg.apiFormat = ['auto', 'openai', 'compatible'].includes(cfg.apiFormat) ? cfg.apiFormat : 'auto';
    cfg.baseURL = normalizeBaseURL(cfg.baseURL, cfg.apiFormat);
    cfg.apiKey = String(cfg.apiKey || '').trim();
    cfg.model = String(cfg.model || '').trim().slice(0, 160);
    cfg.targetLang = String(cfg.targetLang || DEFAULTS.targetLang).trim().slice(0, 80);
    cfg.reasoningEffort = ['auto', 'low', 'medium', 'high'].includes(cfg.reasoningEffort) ? cfg.reasoningEffort : 'auto';
    cfg.viewMode = ['bilingual', 'translated', 'original'].includes(cfg.viewMode) ? cfg.viewMode : 'bilingual';
    cfg.enabled = Boolean(cfg.enabled);
    cfg.structuredOutput = Boolean(cfg.structuredOutput);
    cfg.requestTimeoutSeconds = clamp(cfg.requestTimeoutSeconds, 15, 300, DEFAULTS.requestTimeoutSeconds);
    cfg.prefetchSeconds = clamp(cfg.prefetchSeconds, 15, MAX_PREFETCH_SECONDS, DEFAULTS.prefetchSeconds);
    cfg.batchSize = clamp(cfg.batchSize, 1, MAX_BATCH_SIZE, DEFAULTS.batchSize);
    cfg.originalFont = clamp(cfg.originalFont, 12, 32, 18);
    cfg.translatedFont = clamp(cfg.translatedFont, 12, 36, 22);
    return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, cfg[key]]));
  }

  function publicConfig(cfg) {
    const { apiKey, ...rest } = cfg;
    return { ...rest, hasApiKey: Boolean(apiKey) };
  }

  function getVideoId(href) {
    try {
      const url = new URL(href);
      const id = url.searchParams.get('v');
      return url.origin === 'https://www.youtube.com' && url.pathname === '/watch' && VIDEO_ID_RE.test(id || '') ? id : null;
    } catch { return null; }
  }

  function captionURL(value, videoId) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== videoId) return null;
      return url;
    } catch { return null; }
  }

  function trackKey(url) {
    return ['lang', 'kind', 'name', 'tlang'].map(key => url.searchParams.get(key) || '').join('|');
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCues(input) {
    const cues = input.map(cue => ({ start: cue.start, end: Math.max(cue.start + 100, cue.end), text: cleanText(cue.text) }))
      .filter(cue => Number.isFinite(cue.start) && cue.start >= 0 && Number.isFinite(cue.end) && cue.text)
      .sort((a, b) => a.start - b.start);
    const result = [];
    for (const cue of cues) {
      const previous = result.at(-1);
      if (previous && previous.start === cue.start) {
        if (previous.text !== cue.text) previous.text += ' ' + cue.text;
        previous.end = Math.max(previous.end, cue.end);
      } else result.push(cue);
    }
    for (let i = 0; i < result.length - 1; i++) {
      result[i].end = Math.min(result[i].end, result[i + 1].start);
    }
    return result.filter(cue => cue.end > cue.start && cue.text);
  }

  function parseCaptions(body) {
    if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_SIZE) return [];
    let cues = [];
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data.events)) {
        cues = data.events.filter(event => Array.isArray(event.segs)).map(event => {
          const start = Number(event.tStartMs);
          const duration = Number(event.dDurationMs);
          return { start, end: start + (duration > 0 ? duration : 2000), text: event.segs.map(seg => seg.utf8 || '').join('') };
        });
        return normalizeCues(cues);
      }
    } catch { /* Non-JSON caption formats are parsed as XML below. */ }
    if (typeof DOMParser === 'undefined') return [];
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return [];
    const legacy = Array.from(doc.getElementsByTagName('text'));
    if (legacy.length) {
      cues = legacy.map(node => {
        const start = Number(node.getAttribute('start')) * 1000;
        return { start, end: start + (Number(node.getAttribute('dur')) || 2) * 1000, text: node.textContent };
      });
    } else {
      cues = Array.from(doc.getElementsByTagName('p')).map(node => {
        const start = Number(node.getAttribute('t'));
        return { start, end: start + (Number(node.getAttribute('d')) || 2000), text: node.textContent };
      });
    }
    return normalizeCues(cues);
  }

  function groupCues(cues) {
    const groups = [];
    let current = null;
    for (const cue of cues) {
      const close = current && (TERMINAL.test(current.text) || cue.start - current.end >= 800 ||
        cue.end - current.start > 4500 || current.text.length + cue.text.length + 1 > 160);
      if (close) { groups.push(current); current = null; }
      if (!current) current = { start: cue.start, end: cue.end, text: cue.text };
      else {
        current.end = Math.max(current.end, cue.end);
        current.text += (/[-–—]$/.test(current.text) ? '' : ' ') + cue.text;
      }
    }
    if (current) groups.push(current);
    return groups.map((group, id) => ({ ...group, id }));
  }

  function activeIndex(cues, timeMs) {
    let low = 0, high = cues.length - 1, index = -1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (cues[mid].start <= timeMs) { index = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return index >= 0 && timeMs < cues[index].end ? index : -1;
  }

  function pickBatch(cues, timeMs, cfg) {
    const active = activeIndex(cues, timeMs);
    const end = timeMs + cfg.prefetchSeconds * 1000;
    const candidates = cues.filter(cue => !cue.translated &&
      (cue.id === active || (cue.start >= timeMs && cue.start <= end)));
    const lines = candidates.slice(0, cfg.batchSize).map(({ id, text }) => ({ id, text }));
    if (!lines.length) return null;
    return {
      lines,
      context_before: cues.slice(Math.max(0, lines[0].id - 3), lines[0].id).map(cue => cue.text),
      context_after: cues.slice(lines.at(-1).id + 1, lines.at(-1).id + 4).map(cue => cue.text)
    };
  }

  function parseTranslations(content, lines, instructions = []) {
    if (typeof content !== 'string') throw new Error('模型没有返回文字译文');
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { throw new Error('模型没有返回有效的 JSON 译文'); }
    const items = Array.isArray(parsed?.translations) ? parsed.translations :
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.entries(parsed).map(([id, text]) => ({ id: Number(id), text })) : [];
    const wanted = new Set(lines.map(line => line.id));
    const seen = new Set();
    const translations = [];
    for (const item of items) {
      if (!Number.isInteger(item.id) || !wanted.has(item.id) || seen.has(item.id) || typeof item.text !== 'string' || !item.text.trim()) continue;
      const source = lines.find(line => line.id === item.id)?.text;
      if (isPromptEcho(item.text, source, instructions) || !isTranslationPlausible(item.text, source)) continue;
      seen.add(item.id);
      translations.push({ id: item.id, text: item.text.trim().slice(0, 2000) });
    }
    return { translations, missing: lines.filter(line => !seen.has(line.id)) };
  }

  function isTranslationPlausible(value, source) {
    if (typeof value !== 'string' || !value.trim() || typeof source !== 'string' || !source.trim()) return false;
    // CJK characters carry more information than individual Latin letters.
    // Use a generous language-aware expansion bound to reject paragraphs
    // assigned to a short cue; never truncate them into an apparent success.
    const size = text => {
      const cjk = [...text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)].length;
      const other = [...text.replace(/[\p{P}\p{S}\s]/gu, '')].length - cjk;
      return cjk + Math.max(0, other) / 3;
    };
    return size(value) <= Math.max(32, size(source) * 2.5 + 8);
  }

  function isPromptEcho(value, source = '', instructions = []) {
    const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
    // Include the previous prompt so a model repeating its old wording is
    // rejected as well. Current instructions are supplied by the requester.
    const clauses = [
      '每个输入编号必须返回一行', '保留每行开头的 [编号]',
      '格式必须是 [编号] 翻译内容', '除这些译文行外，不要输出 JSON',
      '不要合并、删除或新增字幕', '每行译文保持在一行',
      '仅供理解的上下文（不要翻译或输出）', '参考信息（无需翻译）',
      ...instructions.flatMap(text => text.split(/[。！？.!?\n,，;；]/u))
    ].map(normalize).filter(text => text.length >= 8);
    const output = normalize(value), original = normalize(source);
    return clauses.some(clause => output.includes(clause) && !original.includes(clause));
  }

  function cleanPlainTranslation(value) {
    return String(value || '').trim()
      .replace(/^```(?:text|txt)?\s*/i, '').replace(/\s*```$/i, '')
      .replace(/^[-*]\s+/, '')
      .replace(/([。！？.!?])\s*["“”'’]?\s*\}\s*\]\s*\}\s*[。！？.!?]?\s*$/u, '$1')
      .replace(/\s*["“”'’]?\s*\}\s*\]\s*\}\s*[。！？.!?]?\s*$/u, '')
      .replace(/^["“”'’`]+\s*/, '')
      .replace(/\s*["“”'’`]+\s*$/, '')
      .replace(/\r?\n+/g, ' ')
      .trim();
  }

  function numberedRows(content) {
    const collect = (pattern, value) => {
      const matches = [...value.matchAll(pattern)];
      return matches.map((match, index) => ({
        id: Number(match[1]),
        text: cleanPlainTranslation(value.slice(match.index + match[0].length,
          index + 1 < matches.length ? matches[index + 1].index : value.length))
      })).filter(row => row.text);
    };
    // Bracketed IDs are the requested Hy-MT2 format. This also handles a
    // model that puts several `[id] text` records on one physical line.
    const bracketed = collect(/(?:\[|【|<|〈|《|（|\()\s*(\d+)\s*(?:\]|】|>|〉|》|）|\))\s*/gu, content);
    if (bracketed.length) return bracketed;
    // Some local runtimes rewrite the markers as `id. text` or `id: text`.
    // A numeric value inside ordinary prose is not a row marker: the
    // numbered-list format must start with a marker of its own.
    if (!/^\s*(?:["“”'’`])?\s*\d+\s*(?:[.。:：、\-](?!\d)|[）)])/u.test(content)) return [];
    return collect(/(?:^|[\r\n]|\s)(?:["“”'’`])?\s*(\d+)\s*(?:[.。:：、\-](?!\d)|[）)])\s*/gmu, content);
  }

  function cleanTranslationText(value, id = null) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const plain = cleanPlainTranslation(raw);
    const rows = numberedRows(raw);
    const bracketed = /[\[【<〈《（(]\s*\d+\s*[\]】>〉》）)]/u;
    const startsWithMarker = new RegExp('^\\s*' + bracketed.source, 'u').test(plain);
    // Numeric list labels may be part of a real subtitle. The response
    // parser removes transport numbering once; cache/render cleanup must
    // preserve dates, decimals and numbered steps in the resulting text.
    if (rows.length && (startsWithMarker || (bracketed.test(raw) && rows.length > 1))) {
      const selected = Number.isInteger(id) ? rows.find(row => row.id === id) : null;
      return (selected?.text || rows[0].text || '').slice(0, 2000).trim();
    }
    return plain.slice(0, 2000);
  }

  function mapNumberedRows(rows, lines, allowOrder = true) {
    const wanted = new Set(lines.map(line => line.id));
    const matching = rows.filter(row => wanted.has(row.id));
    // Reset IDs can be matched by order only for a complete, consecutive
    // response. Partial or mixed instruction lists have ambiguous positions.
    const consecutive = rows.every((row, index) => row.id === index) || rows.every((row, index) => row.id === index + 1);
    const orderMode = allowOrder && rows.length === lines.length && matching.length < rows.length && consecutive;
    if (orderMode) {
      return rows.slice(0, lines.length).map((row, index) => ({ id: lines[index].id, text: row.text }));
    }
    const seen = new Set();
    const mapped = [];
    for (const row of rows) {
      if (!wanted.has(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      mapped.push(row);
    }
    return mapped;
  }

  function parseLineTranslations(content, lines, instructions = []) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回文字译文');
    const cleaned = content.trim();
    let structured;
    try {
      structured = parseTranslations(cleaned, lines, instructions);
    } catch { /* Hy-MT2 normally returns numbered plain text, not JSON. */ }
    let retryIndividually = false;
    const finish = translations => {
      const accepted = translations.filter(line => {
        const source = lines.find(source => source.id === line.id)?.text;
        const markers = numberedRows(line.text);
        const extraMarkers = markers.length > 1 || (markers.length === 1 && markers[0].id !== line.id &&
          /[\[【<〈《（(]\s*\d+\s*[\]】>〉》）)]/u.test(line.text));
        if (!isTranslationPlausible(line.text, source) || (extraMarkers && !numberedRows(source || '').length)) {
          retryIndividually = true;
          return false;
        }
        return !isPromptEcho(line.text, source, instructions);
      }).map(line => ({ ...line, text: cleanTranslationText(line.text, line.id) })).filter(line => line.text);
      const seen = new Set(accepted.map(line => line.id));
      return { translations: accepted, missing: lines.filter(line => !seen.has(line.id)), ...(retryIndividually ? { retryIndividually: true } : {}) };
    };
    if (structured) {
      retryIndividually = structured.missing.length > 0;
      return finish(retryIndividually && lines.length > 1 ? [] : structured.translations);
    }
    const hasEcho = isPromptEcho(cleaned, lines.map(line => line.text).join('\n'), instructions);
    const startsWithBracket = /^\s*["“”'’`]*\s*[\[【<〈《（(]\s*\d+\s*[\]】>〉》）)]/u.test(cleaned);
    // Single-subtitle prompts do not request numbering. Preserve numeric
    // text instead of interpreting a year or list item as a response ID.
    if (lines.length === 1 && !startsWithBracket) return finish(hasEcho ? [] : [{ id: lines[0].id, text: cleaned }]);
    const numbered = numberedRows(cleaned);
    const validRows = numbered.filter(row => !isPromptEcho(row.text,
      lines.find(line => line.id === row.id)?.text ?? lines.map(line => line.text).join('\n'), instructions));
    const plainRows = cleaned.replace(/```(?:text|txt)?/gi, '').replace(/```/g, '').split(/\r?\n/);
    const translations = mapNumberedRows(validRows, lines, !hasEcho && validRows.length === numbered.length);
    const mappedMarkers = mapNumberedRows(numbered, lines, !hasEcho && validRows.length === numbered.length);
    const marked = new Set(mappedMarkers.map(line => line.id));
    if (lines.length > 1 && numbered.length && (marked.size < lines.length || numbered.length !== lines.length)) {
      // Hy-MT2 can merge rows and then renumber every following translation.
      // No prefix can be trusted when the full marker set/count is missing.
      retryIndividually = true;
      return finish([]);
    }
    if (lines.length === 1 && numbered.length > 1) { retryIndividually = true; return finish([]); }
    if (!numbered.length && !hasEcho) {
      const rows = plainRows.map(row => cleanTranslationText(row)).filter(Boolean);
      // Without markers, only an exact row count establishes correspondence.
      // A shorter response can be merged rather than partially translated.
      if (rows.length && rows.length === lines.length) {
        return finish(rows.map((text, index) => ({ id: lines[index].id, text })));
      }
      retryIndividually = true;
      return finish([]);
    }
    return finish(translations);
  }

  async function digest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  globalThis.YTAICore = Object.freeze({
    DEFAULTS, CHANNEL, MAX_BODY_SIZE, MAX_BATCH_SIZE, MAX_PREFETCH_SECONDS, VIDEO_ID_RE, clamp, isLocalAPI, isHyMTModel, isCompatibleAPI, normalizeBaseURL, normalizeConfig, publicConfig,
    getVideoId, captionURL, trackKey, parseCaptions, normalizeCues, groupCues, activeIndex, pickBatch, parseTranslations, parseLineTranslations, cleanTranslationText, isTranslationPlausible, digest
  });
})();
