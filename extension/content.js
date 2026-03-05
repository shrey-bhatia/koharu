// Koharu Firefox Extension — Content Script
// Handles: hover overlay, CSS class watcher, image swap, progress indicator

(() => {
  'use strict';

  // ============================================================================
  // State
  // ============================================================================

  /** @type {Set<string>} URLs currently being translated */
  const pendingTranslations = new Set();

  /** @type {Map<string, string>} original URL → translated data URL (local mirror) */
  const localCache = new Map();

  /** @type {Map<Element, string>} element → original src (for toggle) */
  const originalSources = new Map();

  /** @type {WeakSet<Element>} Elements we've already processed for class-based API */
  const processedClassElements = new WeakSet();

  /** @type {boolean} */
  let autoHover = true;
  let autoSingleImage = false;

  // ============================================================================
  // Settings Sync
  // ============================================================================

  async function syncSettings() {
    try {
      const stored = await browser.storage.local.get([
        'autoTranslateOnHover',
        'autoTranslateSingleImage'
      ]);
      autoHover = stored.autoTranslateOnHover !== false;
      autoSingleImage = stored.autoTranslateSingleImage || false;
    } catch (e) {
      // Storage not available — use defaults
    }
  }
  syncSettings();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.autoTranslateOnHover) autoHover = changes.autoTranslateOnHover.newValue;
    if (changes.autoTranslateSingleImage) autoSingleImage = changes.autoTranslateSingleImage.newValue;
  });

  // ============================================================================
  // CSS Injection
  // ============================================================================

  const style = document.createElement('style');
  style.textContent = `
    .koharu-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 10000;
      transition: opacity 0.2s ease;
    }

    .koharu-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-top: 3px solid #fff;
      border-radius: 50%;
      animation: koharu-spin 0.8s linear infinite;
      filter: drop-shadow(0 0 4px rgba(0,0,0,0.5));
    }

    @keyframes koharu-spin {
      to { transform: rotate(360deg); }
    }

    .koharu-error-badge {
      background: rgba(239, 68, 68, 0.9);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: system-ui, sans-serif;
      max-width: 200px;
      text-align: center;
      filter: drop-shadow(0 0 4px rgba(0,0,0,0.5));
    }

    .koharu-hover-hint {
      position: absolute;
      bottom: 4px;
      right: 4px;
      background: rgba(0,0,0,0.6);
      color: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-family: system-ui, sans-serif;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease;
      z-index: 10001;
    }

    img[data-koharu-translatable]:hover + .koharu-hover-hint,
    img[data-koharu-translatable]:hover ~ .koharu-hover-hint {
      opacity: 1;
    }

    .koharu-translated {
      outline: 2px solid rgba(34, 197, 94, 0.6);
      outline-offset: -2px;
    }

    .koharu-toggle-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      background: rgba(0,0,0,0.7);
      color: white;
      border: none;
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 11px;
      font-family: system-ui, sans-serif;
      cursor: pointer;
      z-index: 10001;
      opacity: 0;
      transition: opacity 0.15s ease;
      pointer-events: auto;
    }

    .koharu-wrapper:hover .koharu-toggle-btn {
      opacity: 1;
    }

    .koharu-toggle-btn:hover {
      background: rgba(0,0,0,0.9);
    }
  `;
  document.head.appendChild(style);

  // ============================================================================
  // Image Analysis
  // ============================================================================

  /**
   * Determine if an image is worth translating (large enough, not an icon).
   * @param {HTMLImageElement} img
   * @returns {boolean}
   */
  function isTranslatableImage(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    if (w < MIN_IMAGE_WIDTH || h < MIN_IMAGE_HEIGHT) return false;

    // Skip known non-manga patterns
    const src = img.src || '';
    if (src.startsWith('data:image/svg') || src.endsWith('.svg')) return false;
    if (src.includes('avatar') || src.includes('icon') || src.includes('logo')) return false;
    if (src.includes('emoji') || src.includes('badge') || src.includes('button')) return false;

    return true;
  }

  // ============================================================================
  // Loading Overlay
  // ============================================================================

  /**
   * Show a loading spinner over an image.
   * @param {HTMLImageElement} img
   * @returns {HTMLElement} overlay element
   */
  function showLoadingOverlay(img) {
    const existing = img.parentElement?.querySelector('.koharu-overlay');
    if (existing) return existing;

    // Ensure parent is positioned
    const parent = img.parentElement;
    if (parent) {
      const pos = getComputedStyle(parent).position;
      if (pos === 'static') parent.style.position = 'relative';
    }

    const overlay = document.createElement('div');
    overlay.className = 'koharu-overlay';
    overlay.innerHTML = '<div class="koharu-spinner"></div>';

    if (parent) {
      parent.appendChild(overlay);
    }

    return overlay;
  }

  /**
   * Remove loading overlay and optionally show an error.
   * @param {HTMLImageElement} img
   * @param {string|null} errorMsg
   */
  function removeOverlay(img, errorMsg) {
    const parent = img.parentElement;
    if (!parent) return;

    const overlay = parent.querySelector('.koharu-overlay');
    if (overlay) {
      if (errorMsg) {
        overlay.innerHTML = `<div class="koharu-error-badge">${errorMsg}</div>`;
        setTimeout(() => overlay.remove(), 3000);
      } else {
        overlay.remove();
      }
    }
  }

  // ============================================================================
  // Image Translation & Swap
  // ============================================================================

  /**
   * Request translation for an image element.
   * @param {HTMLImageElement} img
   */
  function requestTranslation(img) {
    const imageUrl = img.src;

    if (!imageUrl || imageUrl.startsWith('data:')) return;
    if (pendingTranslations.has(imageUrl)) return;
    if (localCache.has(imageUrl)) {
      swapImage(img, localCache.get(imageUrl));
      return;
    }

    // Check background cache first
    browser.runtime.sendMessage({ action: 'check-cache', imageUrl }).then(resp => {
      if (resp?.cached && resp.dataUrl) {
        localCache.set(imageUrl, resp.dataUrl);
        swapImage(img, resp.dataUrl);
      } else {
        // Request translation from background
        pendingTranslations.add(imageUrl);
        showLoadingOverlay(img);

        browser.runtime.sendMessage({
          action: 'translate',
          imageUrl
        });
      }
    }).catch(err => {
      console.error('[Koharu] Failed to check cache:', err);
    });
  }

  /**
   * Swap an image's src with the translated version.
   * @param {HTMLImageElement} img
   * @param {string} dataUrl
   */
  function swapImage(img, dataUrl) {
    const originalSrc = img.src;

    // Save original source for toggle
    if (!originalSources.has(img)) {
      originalSources.set(img, originalSrc);
    }

    img.src = dataUrl;
    img.classList.add('koharu-translated');
    img.dataset.koharuOriginal = originalSrc;

    removeOverlay(img, null);

    // Add toggle button
    addToggleButton(img);
  }

  /**
   * Add a toggle button to switch between original and translated.
   * @param {HTMLImageElement} img
   */
  function addToggleButton(img) {
    const parent = img.parentElement;
    if (!parent || parent.querySelector('.koharu-toggle-btn')) return;

    // Wrap in positioned container if needed
    if (!parent.classList.contains('koharu-wrapper')) {
      const pos = getComputedStyle(parent).position;
      if (pos === 'static') parent.style.position = 'relative';
      parent.classList.add('koharu-wrapper');
    }

    const btn = document.createElement('button');
    btn.className = 'koharu-toggle-btn';
    btn.textContent = 'Original';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const original = originalSources.get(img);
      if (!original) return;

      if (img.src === original) {
        // Switch to translated
        const translated = localCache.get(original);
        if (translated) {
          img.src = translated;
          img.classList.add('koharu-translated');
          btn.textContent = 'Original';
        }
      } else {
        // Switch to original
        img.src = original;
        img.classList.remove('koharu-translated');
        btn.textContent = 'Translated';
      }
    });

    parent.appendChild(btn);
  }

  // ============================================================================
  // Hover Translation
  // ============================================================================

  /** @type {number|null} */
  let hoverTimer = null;

  function setupHoverListeners() {
    document.addEventListener('mouseenter', (e) => {
      if (!autoHover) return;
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (!isTranslatableImage(img)) return;
      if (img.classList.contains('koharu-translated')) return;
      if (pendingTranslations.has(img.src)) return;

      // Small delay to avoid accidental hovers
      hoverTimer = setTimeout(() => {
        requestTranslation(img);
      }, 300);
    }, true);

    document.addEventListener('mouseleave', (e) => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }, true);
  }

  setupHoverListeners();

  // ============================================================================
  // CSS Class API (for ViolentMonkey / userscripts)
  // ============================================================================

  /**
   * Watch for elements with the KOHARU_TRANSLATE_CLASS and auto-translate them.
   */
  function setupClassWatcher() {
    // Process existing elements
    document.querySelectorAll(`.${KOHARU_TRANSLATE_CLASS}`).forEach(processClassElement);

    // Watch for new elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check added nodes
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.classList?.contains(KOHARU_TRANSLATE_CLASS)) {
            processClassElement(node);
          }

          // Check descendants
          const descendants = node.querySelectorAll?.(`.${KOHARU_TRANSLATE_CLASS}`);
          descendants?.forEach(processClassElement);
        }

        // Check attribute changes (class added to existing element)
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const el = mutation.target;
          if (el.classList?.contains(KOHARU_TRANSLATE_CLASS)) {
            processClassElement(el);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  /**
   * Process an element marked with the koharu-translate class.
   * @param {Element} el
   */
  function processClassElement(el) {
    if (processedClassElements.has(el)) return;
    processedClassElements.add(el);

    if (el instanceof HTMLImageElement) {
      if (el.complete && el.naturalWidth > 0) {
        requestTranslation(el);
      } else {
        el.addEventListener('load', () => requestTranslation(el), { once: true });
      }
    } else {
      // It might be a container — find images inside
      const imgs = el.querySelectorAll('img');
      imgs.forEach(img => {
        processedClassElements.add(img);
        if (img.complete && img.naturalWidth > 0) {
          requestTranslation(img);
        } else {
          img.addEventListener('load', () => requestTranslation(img), { once: true });
        }
      });
    }
  }

  // Wait for body to be available
  if (document.body) {
    setupClassWatcher();
  } else {
    document.addEventListener('DOMContentLoaded', setupClassWatcher);
  }

  // ============================================================================
  // Single-Image Page Auto-Translate
  // ============================================================================

  function checkSingleImagePage() {
    if (!autoSingleImage) return;

    // Check if page is essentially a single image (direct image URL or viewer page)
    const images = document.querySelectorAll('img');
    const largeImages = Array.from(images).filter(isTranslatableImage);

    if (largeImages.length === 1) {
      console.log('[Koharu] Single large image detected, auto-translating');
      requestTranslation(largeImages[0]);
    }
  }

  window.addEventListener('load', () => {
    setTimeout(checkSingleImagePage, 1000);
  });

  // ============================================================================
  // Message Handler (from background script)
  // ============================================================================

  browser.runtime.onMessage.addListener((message) => {
    switch (message.action) {
      case 'translation-result': {
        const { imageUrl, dataUrl, success, error } = message;
        pendingTranslations.delete(imageUrl);

        // Find all images with this URL on the page
        const images = document.querySelectorAll(`img[src="${CSS.escape(imageUrl)}"]`);

        if (success && dataUrl) {
          localCache.set(imageUrl, dataUrl);
          images.forEach(img => swapImage(img, dataUrl));
        } else {
          images.forEach(img => removeOverlay(img, error || 'Translation failed'));
        }
        break;
      }

      case 'translate-all-images': {
        console.log('[Koharu] Translating all images on page');
        const allImages = document.querySelectorAll('img');
        allImages.forEach(img => {
          if (isTranslatableImage(img) && !img.classList.contains('koharu-translated')) {
            requestTranslation(img);
          }
        });
        break;
      }

      case 'context-translate': {
        // Find the image element matching this URL and translate it
        const { imageUrl } = message;
        const img = document.querySelector(`img[src="${CSS.escape(imageUrl)}"]`);
        if (img) {
          requestTranslation(img);
        } else {
          // Image might be in a srcset or background — try fetching directly
          browser.runtime.sendMessage({ action: 'translate', imageUrl });
        }
        break;
      }
    }
  });

  // ============================================================================
  // Cleanup on page unload
  // ============================================================================

  window.addEventListener('beforeunload', () => {
    pendingTranslations.clear();
    localCache.clear();
    originalSources.clear();
  });

  console.log('[Koharu] Content script loaded');
})();
