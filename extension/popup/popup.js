// Koharu Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const serverStatus = document.getElementById('server-status');
  const gpuStatus = document.getElementById('gpu-status');
  const providerStatus = document.getElementById('provider-status');
  const cacheStatus = document.getElementById('cache-status');
  const queueStatus = document.getElementById('queue-status');
  const toggleHover = document.getElementById('toggle-hover');
  const toggleSingle = document.getElementById('toggle-single');
  const btnTranslateAll = document.getElementById('btn-translate-all');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const openOptions = document.getElementById('open-options');
  const versionText = document.getElementById('version-text');

  // Show version
  const manifest = browser.runtime.getManifest();
  versionText.textContent = `v${manifest.version}`;

  // Load current state
  async function refresh() {
    try {
      const status = await browser.runtime.sendMessage({ action: 'get-status' });

      if (status.connected) {
        statusDot.className = 'status-dot connected';
        serverStatus.textContent = `Connected (:${status.port})`;
        btnTranslateAll.disabled = false;
      } else {
        statusDot.className = 'status-dot disconnected';
        serverStatus.textContent = 'Not running';
        btnTranslateAll.disabled = true;
      }

      providerStatus.textContent = status.provider || '—';
      cacheStatus.textContent = `${status.cacheSize} images`;
      queueStatus.textContent = status.queueLength > 0 ? `${status.queueLength} pending` : 'Idle';
      toggleHover.checked = status.autoHover;
      toggleSingle.checked = status.autoSingleImage;

      // Get GPU info via health check
      const health = await browser.runtime.sendMessage({ action: 'check-health' });
      if (health?.data?.gpu) {
        gpuStatus.textContent = health.data.gpu;
      }
    } catch (err) {
      serverStatus.textContent = 'Error';
      console.error('[Koharu Popup]', err);
    }
  }

  refresh();
  // Refresh every 5 seconds while popup is open
  const refreshInterval = setInterval(refresh, 5000);

  // Toggle handlers
  toggleHover.addEventListener('change', () => {
    browser.storage.local.set({ autoTranslateOnHover: toggleHover.checked });
  });

  toggleSingle.addEventListener('change', () => {
    browser.storage.local.set({ autoTranslateSingleImage: toggleSingle.checked });
  });

  // Translate All button
  btnTranslateAll.addEventListener('click', async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      browser.tabs.sendMessage(tab.id, { action: 'translate-all-images' }).catch(() => {});
      window.close();
    }
  });

  // Clear Cache button
  btnClearCache.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ action: 'clear-cache' });
    refresh();
  });

  // Open Options
  openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
});
