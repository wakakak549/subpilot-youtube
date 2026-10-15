const UI = globalThis.YTAIUI;
let config, tabId;
async function refreshStatus() {
  const detail = document.getElementById('videoDetail');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    const status = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
    document.getElementById('videoStatus').textContent = status.label;
    document.getElementById('statusDot').dataset.state = status.code;
    detail.textContent = status.error?.message || (status.total ? `已翻译 ${status.ready}/${status.total} 段 · 缓存命中 ${status.cacheHits} 段` : '');
    document.getElementById('retry').disabled = !status.videoId || !config?.enabled;
  } catch {
    document.getElementById('videoStatus').textContent = '未连接视频页';
    document.getElementById('statusDot').dataset.state = 'IDLE';
    detail.textContent = '';
    document.getElementById('retry').disabled = true;
  }
}
async function load() {
  const response = await UI.request({ type: 'GET_CONFIG' });
  config = response.config;
  document.getElementById('enabled').checked = config.enabled;
  document.querySelector(`[name="viewMode"][value="${config.viewMode}"]`).checked = true;
  document.getElementById('modelName').textContent = config.model || '未配置模型';
  await refreshStatus();
}
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('enabled').addEventListener('change', async event => {
  try { await UI.request({ type: 'SET_ENABLED', enabled: event.target.checked }); await load(); }
  catch (error) { UI.notice(error.message, 'error'); await load(); }
});
for (const input of document.querySelectorAll('[name="viewMode"]')) input.addEventListener('change', async event => {
  try { config.viewMode = event.target.value; await UI.request({ type: 'SET_VIEW_MODE', viewMode: config.viewMode }); await refreshStatus(); }
  catch (error) { UI.notice(error.message, 'error'); }
});
document.getElementById('retry').addEventListener('click', async () => {
  try { await UI.request({ type: 'RETRY_TAB', tabId }); await refreshStatus(); }
  catch (error) { UI.notice(error.message, 'error'); }
});
UI.icons();
load().catch(error => UI.notice(error.message, 'error'));
setInterval(refreshStatus, 1500);
