(function () {
  const icons = () => globalThis.YTAIIcons?.();
  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error.message);
    return response;
  }
  function notice(text, kind = 'info') {
    const element = document.getElementById('notice');
    element.textContent = text;
    element.dataset.kind = kind;
  }
  async function grant(baseURL) {
    const origin = new URL(baseURL).origin + '/*';
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('未获得接口访问权限');
  }
  function busy(button, value) {
    button.disabled = value;
    button.setAttribute('aria-busy', String(value));
  }
  globalThis.YTAIUI = { request, notice, grant, busy, icons };
})();
