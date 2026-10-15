const Core = globalThis.YTAICore;
const UI = globalThis.YTAIUI;
const form = document.getElementById('configForm');
form.inert = true;
const valueFields = ['baseURL', 'apiKey', 'model', 'apiFormat', 'targetLang', 'reasoningEffort', 'requestTimeoutSeconds', 'prefetchSeconds', 'batchSize', 'originalFont', 'translatedFont'];
document.getElementById('batchSize').max = Core.MAX_BATCH_SIZE;
document.getElementById('prefetchSeconds').max = Core.MAX_PREFETCH_SECONDS;

function readConfig() {
  const cfg = Object.fromEntries(valueFields.map(key => [key, document.getElementById(key).value]));
  cfg.enabled = document.getElementById('enabled').checked;
  cfg.structuredOutput = document.getElementById('structuredOutput').checked;
  cfg.viewMode = form.querySelector('[name="viewMode"]:checked')?.value || 'bilingual';
  return Core.normalizeConfig(cfg);
}
function updateOutputs() {
  for (const key of ['originalFont', 'translatedFont', 'prefetchSeconds']) {
    document.getElementById(key + 'Value').textContent = document.getElementById(key).value + (key === 'prefetchSeconds' ? ' 秒' : ' px');
  }
}
function fillConfig(cfg) {
  for (const key of valueFields) {
    const element = document.getElementById(key);
    if (element.tagName === 'SELECT' && !Array.from(element.options).some(option => option.value === cfg[key])) element.add(new Option(cfg[key], cfg[key]));
    element.value = cfg[key];
  }
  document.getElementById('enabled').checked = cfg.enabled;
  document.getElementById('structuredOutput').checked = cfg.structuredOutput;
  form.querySelector(`[name="viewMode"][value="${cfg.viewMode}"]`).checked = true;
  updateOutputs();
}
async function updateCache() {
  const { stats } = await UI.request({ type: 'CACHE_STATS' });
  document.getElementById('cacheStats').textContent = `${stats.entries} 条译文 · ${(stats.bytes / 1024 / 1024).toFixed(2)} MB / 3 MB`;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('save');
  try {
    const cfg = readConfig();
    const permission = UI.grant(cfg.baseURL);
    UI.busy(button, true);
    await permission;
    const response = await UI.request({ type: 'SAVE_CONFIG', config: cfg });
    fillConfig({ ...cfg, ...response.config });
    UI.notice('配置已保存', 'success');
  } catch (error) { UI.notice(error.message, 'error'); }
  finally { UI.busy(button, false); }
});
document.getElementById('test').addEventListener('click', async () => {
  const button = document.getElementById('test');
  try {
    const cfg = readConfig();
    const permission = UI.grant(cfg.baseURL);
    UI.busy(button, true);
    UI.notice('正在连接');
    await permission;
    const response = await UI.request({ type: 'TEST_CONNECTION', config: cfg });
    UI.notice('连接成功 · ' + response.sample, 'success');
  } catch (error) { UI.notice(error.message, 'error'); }
  finally { UI.busy(button, false); }
});
document.getElementById('loadModels').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    const cfg = readConfig();
    const permission = UI.grant(cfg.baseURL);
    UI.busy(button, true);
    UI.notice('正在获取模型');
    await permission;
    const response = await UI.request({ type: 'LIST_MODELS', config: cfg });
    document.getElementById('baseURL').value = cfg.baseURL;
    document.getElementById('modelOptions').replaceChildren(...response.models.map(model => new Option(model, model)));
    const selected = !response.models.includes(cfg.model);
    if (selected) document.getElementById('model').value = response.models[0];
    UI.notice(`已获取 ${response.models.length} 个模型` + (selected ? ' · 已选择 ' + response.models[0] : ''), 'success');
  } catch (error) { UI.notice(error.message, 'error'); }
  finally { UI.busy(button, false); }
});
document.getElementById('baseURL').addEventListener('input', () => document.getElementById('modelOptions').replaceChildren());
document.getElementById('clearCache').addEventListener('click', async event => {
  const button = event.currentTarget;
  UI.busy(button, true);
  try {
    await UI.request({ type: 'CLEAR_CACHE' });
    await updateCache();
    UI.notice('缓存已清空', 'success');
  } catch (error) { UI.notice(error.message, 'error'); }
  finally { UI.busy(button, false); }
});
document.getElementById('toggleKey').addEventListener('click', event => {
  const input = document.getElementById('apiKey');
  const button = event.currentTarget;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  button.title = reveal ? '隐藏密钥' : '显示密钥';
  button.setAttribute('aria-label', button.title);
  const icon = document.createElement('i'); icon.dataset.lucide = reveal ? 'eye-off' : 'eye';
  button.replaceChildren(icon); UI.icons();
});
form.addEventListener('input', updateOutputs);
UI.icons();
UI.request({ type: 'GET_CONFIG' }).then(response => fillConfig(response.config))
  .catch(error => UI.notice(error.message, 'error')).finally(() => { form.inert = false; });
updateCache().catch(error => UI.notice(error.message, 'error'));
