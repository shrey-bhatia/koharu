// Koharu Options Page Script

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const serverPort = document.getElementById('server-port');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const btnTest = document.getElementById('btn-test');

  const provider = document.getElementById('provider');
  const apiKeyGroup = document.getElementById('api-key-group');
  const apiKey = document.getElementById('api-key');
  const apiKeyHint = document.getElementById('api-key-hint');
  const ollamaGroup = document.getElementById('ollama-group');
  const ollamaModel = document.getElementById('ollama-model');
  const ollamaPrompt = document.getElementById('ollama-prompt');

  const sourceLang = document.getElementById('source-lang');
  const targetLang = document.getElementById('target-lang');

  const autoHover = document.getElementById('auto-hover');
  const autoSingle = document.getElementById('auto-single');

  const btnSave = document.getElementById('btn-save');
  const saveStatus = document.getElementById('save-status');

  // ============================================================================
  // Load Saved Settings
  // ============================================================================

  const stored = await browser.storage.local.get([
    'serverPort',
    'translationProvider',
    'apiKey',
    'sourceLang',
    'targetLang',
    'autoTranslateOnHover',
    'autoTranslateSingleImage',
    'ollamaModel',
    'ollamaSystemPrompt'
  ]);

  serverPort.value = stored.serverPort || KOHARU_DEFAULT_PORT;
  provider.value = stored.translationProvider || 'google';
  apiKey.value = stored.apiKey || '';
  sourceLang.value = stored.sourceLang || 'ja';
  targetLang.value = stored.targetLang || 'en';
  autoHover.checked = stored.autoTranslateOnHover !== false;
  autoSingle.checked = stored.autoTranslateSingleImage || false;
  ollamaModel.value = stored.ollamaModel || '';
  ollamaPrompt.value = stored.ollamaSystemPrompt || '';

  updateProviderUI();

  // ============================================================================
  // Provider UI Toggle
  // ============================================================================

  provider.addEventListener('change', updateProviderUI);

  function updateProviderUI() {
    const prov = provider.value;

    if (prov === 'ollama') {
      apiKeyGroup.classList.add('hidden');
      ollamaGroup.classList.remove('hidden');
    } else {
      apiKeyGroup.classList.remove('hidden');
      ollamaGroup.classList.add('hidden');

      // Update hint
      const hints = {
        'google': 'Required — Google Cloud Translation API key',
        'deepl-free': 'Required — DeepL Free API key',
        'deepl-pro': 'Required — DeepL Pro API key'
      };
      apiKeyHint.textContent = hints[prov] || '';
    }
  }

  // ============================================================================
  // Test Connection
  // ============================================================================

  btnTest.addEventListener('click', async () => {
    btnTest.disabled = true;
    btnTest.textContent = 'Testing…';
    statusText.textContent = 'Connecting…';

    try {
      const port = parseInt(serverPort.value) || KOHARU_DEFAULT_PORT;
      const url = getServerUrl(port);
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const data = await response.json();
        statusDot.className = 'dot connected';
        statusText.textContent = `Connected — ${data.gpu || 'No GPU info'}`;
      } else {
        statusDot.className = 'dot disconnected';
        statusText.textContent = `Error: ${response.status}`;
      }
    } catch (err) {
      statusDot.className = 'dot disconnected';
      statusText.textContent = 'Cannot reach server';
    }

    btnTest.disabled = false;
    btnTest.textContent = 'Test Connection';
  });

  // Initial health check
  btnTest.click();

  // ============================================================================
  // Save Settings
  // ============================================================================

  btnSave.addEventListener('click', async () => {
    const settings = {
      serverPort: parseInt(serverPort.value) || KOHARU_DEFAULT_PORT,
      translationProvider: provider.value,
      apiKey: apiKey.value.trim(),
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
      autoTranslateOnHover: autoHover.checked,
      autoTranslateSingleImage: autoSingle.checked,
      ollamaModel: ollamaModel.value.trim() || null,
      ollamaSystemPrompt: ollamaPrompt.value.trim() || null
    };

    await browser.storage.local.set(settings);

    saveStatus.textContent = 'Settings saved!';
    saveStatus.style.opacity = '1';
    setTimeout(() => {
      saveStatus.style.opacity = '0';
    }, 2000);
  });
});
