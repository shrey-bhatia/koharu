// Koharu Firefox Extension — Background Script
// Handles: server communication, translation queue, in-memory cache, context menus

// ============================================================================
// State
// ============================================================================

/** @type {Map<string, string>} URL → data URL cache (memory only) */
const translationCache = new Map();

/** @type {boolean} */
let serverConnected = false;

/** @type {number} */
let serverPort = KOHARU_DEFAULT_PORT;

/** @type {string|null} */
let currentProvider = null;
let currentApiKey = null;
let currentSourceLang = 'ja';
let currentTargetLang = 'en';
let ollamaModel = null;
let ollamaSystemPrompt = null;

/** @type {boolean} */
let autoTranslateOnHover = true;

/** @type {boolean} */
let autoTranslateSingleImage = false;

/** Translation queue — sequential to avoid GPU overload */
const translationQueue = [];
let isProcessingQueue = false;

// ============================================================================
// Initialization
// ============================================================================

browser.runtime.onInstalled.addListener(() => {
  // Create context menus
  browser.contextMenus.create({
    id: 'koharu-translate',
    title: 'Translate with Koharu',
    contexts: ['image']
  });

  browser.contextMenus.create({
    id: 'koharu-save-translated',
    title: 'Save Koharu translated image',
    contexts: ['image']
  });

  browser.contextMenus.create({
    id: 'koharu-translate-all',
    title: 'Translate all images on page',
    contexts: ['page']
  });

  console.log('[Koharu] Extension installed, context menus created');
});

// Load settings on startup
loadSettings().then(() => {
  startHealthCheck();
  console.log('[Koharu] Background script initialized');
});

// ============================================================================
// Settings
// ============================================================================

async function loadSettings() {
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

  serverPort = stored.serverPort || KOHARU_DEFAULT_PORT;
  currentProvider = stored.translationProvider || 'google';
  currentApiKey = stored.apiKey || '';
  currentSourceLang = stored.sourceLang || 'ja';
  currentTargetLang = stored.targetLang || 'en';
  autoTranslateOnHover = stored.autoTranslateOnHover !== false; // default true
  autoTranslateSingleImage = stored.autoTranslateSingleImage || false;
  ollamaModel = stored.ollamaModel || null;
  ollamaSystemPrompt = stored.ollamaSystemPrompt || null;
}

// Listen for settings changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.serverPort) serverPort = changes.serverPort.newValue || KOHARU_DEFAULT_PORT;
  if (changes.translationProvider) currentProvider = changes.translationProvider.newValue;
  if (changes.apiKey) currentApiKey = changes.apiKey.newValue;
  if (changes.sourceLang) currentSourceLang = changes.sourceLang.newValue;
  if (changes.targetLang) currentTargetLang = changes.targetLang.newValue;
  if (changes.autoTranslateOnHover) autoTranslateOnHover = changes.autoTranslateOnHover.newValue;
  if (changes.autoTranslateSingleImage) autoTranslateSingleImage = changes.autoTranslateSingleImage.newValue;
  if (changes.ollamaModel) ollamaModel = changes.ollamaModel.newValue;
  if (changes.ollamaSystemPrompt) ollamaSystemPrompt = changes.ollamaSystemPrompt.newValue;

  console.log('[Koharu] Settings updated');
});

// ============================================================================
// Server Health Check
// ============================================================================

async function checkServerHealth() {
  try {
    const url = getServerUrl(serverPort);
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });

    if (response.ok) {
      const data = await response.json();
      serverConnected = true;
      updateBadge(true, data.gpu);
      return data;
    }

    serverConnected = false;
    updateBadge(false);
    return null;
  } catch (err) {
    serverConnected = false;
    updateBadge(false);
    return null;
  }
}

function startHealthCheck() {
  checkServerHealth();
  setInterval(checkServerHealth, HEALTH_CHECK_INTERVAL);
}

function updateBadge(connected, gpu) {
  if (connected) {
    browser.browserAction.setBadgeText({ text: '✓' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#22c55e' });
    browser.browserAction.setTitle({ title: `Koharu — Connected (${gpu || 'unknown'})` });
  } else {
    browser.browserAction.setBadgeText({ text: '✗' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#ef4444' });
    browser.browserAction.setTitle({ title: 'Koharu — Server not running' });
  }
}

// ============================================================================
// Translation
// ============================================================================

/**
 * Translate an image via the local Koharu server.
 * Returns a data URL of the translated PNG.
 * @param {string} imageUrl - URL of the image to translate
 * @returns {Promise<string>} data URL of translated image
 */
async function translateImage(imageUrl) {
  // Check cache first
  if (translationCache.has(imageUrl)) {
    console.log('[Koharu] Cache hit:', imageUrl.substring(0, 80));
    return translationCache.get(imageUrl);
  }

  if (!serverConnected) {
    throw new Error('Koharu server is not running. Start it from the desktop app.');
  }

  console.log('[Koharu] Translating:', imageUrl.substring(0, 80));

  // Fetch the original image
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image: ${imageResponse.status}`);
  }
  const imageBlob = await imageResponse.blob();

  // Build query params
  const params = new URLSearchParams();
  params.set('provider', currentProvider || 'google');
  if (currentApiKey) params.set('api_key', currentApiKey);
  params.set('source', currentSourceLang || 'ja');
  params.set('target', currentTargetLang || 'en');
  if (currentProvider === 'ollama' && ollamaModel) {
    params.set('model', ollamaModel);
    if (ollamaSystemPrompt) params.set('system_prompt', ollamaSystemPrompt);
  }

  // Send to local server
  const formData = new FormData();
  formData.append('image', imageBlob);

  const serverUrl = getServerUrl(serverPort);
  const response = await fetch(`${serverUrl}/translate-image?${params.toString()}`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Translation failed (${response.status}): ${errorBody}`);
  }

  // Convert response to data URL for injection into page
  const translatedBlob = await response.blob();
  const dataUrl = await blobToDataURL(translatedBlob);

  // Cache the result
  cacheTranslation(imageUrl, dataUrl);

  console.log('[Koharu] Translation complete:', imageUrl.substring(0, 80));
  return dataUrl;
}

/**
 * Add a translated image to the cache, evicting old entries if needed.
 */
function cacheTranslation(url, dataUrl) {
  // Evict oldest entries if cache is full
  if (translationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(url, dataUrl);
}

/**
 * Convert a Blob to a data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============================================================================
// Translation Queue (sequential processing)
// ============================================================================

function enqueueTranslation(tabId, imageUrl, frameId) {
  translationQueue.push({ tabId, imageUrl, frameId });
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue || translationQueue.length === 0) return;
  isProcessingQueue = true;

  while (translationQueue.length > 0) {
    const { tabId, imageUrl, frameId } = translationQueue.shift();

    try {
      const dataUrl = await translateImage(imageUrl);

      // Send result back to content script
      browser.tabs.sendMessage(tabId, {
        action: 'translation-result',
        imageUrl,
        dataUrl,
        success: true
      }, frameId !== undefined ? { frameId } : undefined).catch(() => {
        // Tab may have been closed
      });
    } catch (err) {
      console.error('[Koharu] Translation failed:', err.message);

      browser.tabs.sendMessage(tabId, {
        action: 'translation-result',
        imageUrl,
        dataUrl: null,
        success: false,
        error: err.message
      }, frameId !== undefined ? { frameId } : undefined).catch(() => {});
    }
  }

  isProcessingQueue = false;
}

// ============================================================================
// Message Handler (from content script and popup)
// ============================================================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'translate': {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      enqueueTranslation(tabId, message.imageUrl, sender.frameId);
      return; // Async response via separate message
    }

    case 'check-cache': {
      const cached = translationCache.has(message.imageUrl);
      const dataUrl = cached ? translationCache.get(message.imageUrl) : null;
      sendResponse({ cached, dataUrl });
      return true; // Synchronous response
    }

    case 'get-status': {
      sendResponse({
        connected: serverConnected,
        port: serverPort,
        provider: currentProvider,
        autoHover: autoTranslateOnHover,
        autoSingleImage: autoTranslateSingleImage,
        cacheSize: translationCache.size,
        queueLength: translationQueue.length
      });
      return true;
    }

    case 'get-settings': {
      sendResponse({
        serverPort,
        translationProvider: currentProvider,
        apiKey: currentApiKey,
        sourceLang: currentSourceLang,
        targetLang: currentTargetLang,
        autoTranslateOnHover,
        autoTranslateSingleImage,
        ollamaModel,
        ollamaSystemPrompt
      });
      return true;
    }

    case 'clear-cache': {
      translationCache.clear();
      sendResponse({ success: true });
      return true;
    }

    case 'check-health': {
      checkServerHealth().then(data => {
        sendResponse({ connected: serverConnected, data });
      });
      return true; // Async response
    }

    case 'translate-all': {
      // Content script will find all images and send individual translate requests
      const tabId = sender.tab?.id;
      if (!tabId) return;
      browser.tabs.sendMessage(tabId, { action: 'translate-all-images' }).catch(() => {});
      return;
    }

    case 'save-translated': {
      // Download the translated image
      const dataUrl = translationCache.get(message.imageUrl);
      if (dataUrl) {
        // Extract filename from URL
        const urlObj = new URL(message.imageUrl);
        const pathParts = urlObj.pathname.split('/');
        let filename = pathParts[pathParts.length - 1] || 'translated';
        // Remove extension and add _translated.png
        filename = filename.replace(/\.[^.]+$/, '') + '_translated.png';

        browser.downloads.download({
          url: dataUrl,
          filename: `koharu/${filename}`,
          saveAs: true
        }).catch(err => {
          console.error('[Koharu] Download failed:', err);
        });
      }
      return;
    }
  }
});

// ============================================================================
// Context Menu Handler
// ============================================================================

browser.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'koharu-translate': {
      if (info.srcUrl && tab?.id) {
        // Send translate request via content script
        browser.tabs.sendMessage(tab.id, {
          action: 'context-translate',
          imageUrl: info.srcUrl
        }).catch(() => {});
      }
      break;
    }

    case 'koharu-save-translated': {
      if (info.srcUrl) {
        // Check if we have a translation cached for this URL
        // The srcUrl might be the translated data URL or the original URL
        const originalUrl = info.srcUrl;
        const cached = translationCache.get(originalUrl);
        if (cached) {
          const urlObj = new URL(originalUrl);
          const pathParts = urlObj.pathname.split('/');
          let filename = pathParts[pathParts.length - 1] || 'translated';
          filename = filename.replace(/\.[^.]+$/, '') + '_translated.png';

          browser.downloads.download({
            url: cached,
            filename: `koharu/${filename}`,
            saveAs: true
          }).catch(err => console.error('[Koharu] Download failed:', err));
        } else {
          console.log('[Koharu] No cached translation for:', originalUrl.substring(0, 80));
        }
      }
      break;
    }

    case 'koharu-translate-all': {
      if (tab?.id) {
        browser.tabs.sendMessage(tab.id, { action: 'translate-all-images' }).catch(() => {});
      }
      break;
    }
  }
});

console.log('[Koharu] Background script loaded');
