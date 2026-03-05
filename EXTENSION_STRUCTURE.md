# Koharu Firefox Extension — Architecture Plan

## Overview

A Firefox extension that live-translates manga images in the browser, powered by
the same Rust/ONNX models that run in the Koharu desktop app. The user enables
the extension, right-clicks (or clicks a toolbar button) on any manga image, and
the original `<img>` element is swapped with the fully translated version.

**Key design goal**: Maximum code reuse with the existing Koharu backend crates
(`comic-text-detector`, `manga-ocr`, `lama`) while keeping the extension itself
as thin as possible.

---

## High-Level Architecture

```
┌─────────────────────────────────────────┐
│           Firefox Browser               │
│                                         │
│  ┌───────────────┐  ┌───────────────┐   │
│  │ Content Script │  │  Popup / UI   │   │
│  │ (page inject)  │  │ (settings)    │   │
│  │                │  └───────┬───────┘   │
│  │ • detect <img> │          │ settings  │
│  │ • replace src  │          ▼           │
│  │   with result  │  ┌───────────────┐   │
│  └───────┬────────┘  │  Background   │   │
│          │ message    │  Script       │   │
│          ▼           │               │   │
│  ┌───────────────────┤ • queue imgs  │   │
│  │                   │ • call server │   │
│  │                   │ • cache results│  │
│  │                   └───────┬───────┘   │
│  └───────────────────────────┼───────────┘
                               │ HTTP / WebSocket
                               ▼
              ┌────────────────────────────┐
              │   Koharu Local Server      │
              │   (Rust binary — axum)     │
              │                            │
              │  comic-text-detector ─┐    │
              │  manga-ocr           ├─►  │
              │  lama                ─┘    │
              │                            │
              │  REST API:                 │
              │  POST /translate-image     │
              │  GET  /health              │
              │  POST /detect             │
              │  POST /ocr               │
              │  POST /inpaint           │
              └────────────────────────────┘
```

---

## Component Breakdown

### 1. Koharu Local Server (new Rust binary crate)

**Location**: `koharu-server/` (new crate in workspace)

**What it is**: A headless HTTP server that wraps the same model crates the
desktop app uses. No Tauri dependency — pure Rust with `axum`.

**Why a new crate instead of modifying `src-tauri`**:
- Tauri commands are tightly coupled to the Tauri IPC protocol (JSON-RPC over
  custom protocol). They can't be called over HTTP.
- The model crates (`comic-text-detector`, `manga-ocr`, `lama`) are already
  independent library crates with clean APIs. The Tauri `commands.rs` is just a
  thin adapter layer — we write another thin adapter for HTTP.
- The server can run as a standalone system tray app or background service,
  independent of the desktop GUI.

**Reuse strategy**:

| Component | Reuse | Notes |
|-----------|-------|-------|
| `comic-text-detector` crate | 100% — direct dependency | `ComicTextDetector::new()`, `.inference()` |
| `manga-ocr` crate | 100% — direct dependency | `MangaOCR::new()`, `.inference()` |
| `lama` crate | 100% — direct dependency | `Lama::new()`, `.inference()` |
| `src-tauri/state.rs` | Pattern reuse | Same `Arc<Mutex<Model>>` pattern, new struct |
| `src-tauri/commands.rs` | Logic reuse | Same flow, different transport (HTTP vs Tauri IPC) |
| `src-tauri/ocr_pipeline.rs` | 100% — can extract to shared crate | PaddleOCR pipeline logic |
| `src-tauri/text_renderer.rs` | 100% — can extract to shared crate | `render_text_on_image()` |
| Translation APIs | 100% — server-side fetch | Google/DeepL/Ollama calls move to server |

**API design**:

```
POST /translate-image
  Body: multipart/form-data { image: <binary> }
  Query: ?provider=google&api_key=...&source=ja&target=en
  Response: image/png (fully translated image)

POST /detect
  Body: multipart/form-data { image: <binary> }
  Response: JSON { bboxes: [...], mask_png: base64 }

POST /ocr
  Body: multipart/form-data { image: <binary> }
  Response: JSON { texts: [...] }

POST /inpaint
  Body: multipart/form-data { image: <binary>, mask: <binary> }
  Response: image/png

GET /health
  Response: JSON { status: "ok", gpu: "CUDA", models_loaded: true }

GET /status
  Response: JSON { gpu_info: {...}, models: {...}, version: "0.1.11" }
```

The killer endpoint is `POST /translate-image` — a single call that runs the
full pipeline (detect → OCR → translate → inpaint → render) and returns the
finished image. This is what the extension calls for the simple "just translate
it" flow.

**Cargo.toml** (sketch):

```toml
[package]
name = "koharu-server"
version.workspace = true
edition.workspace = true

[dependencies]
axum = "0.8"
tokio = { workspace = true, features = ["full"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "trace"] }
serde = { workspace = true }
serde_json = { workspace = true }
image = { workspace = true }
anyhow = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
ort = { workspace = true }
reqwest = { workspace = true }
multer = "3"  # multipart parsing

# Same model crates as desktop app
comic-text-detector = { path = "../comic-text-detector" }
manga-ocr = { path = "../manga-ocr" }
lama = { path = "../lama" }

[features]
cuda = ["ort/cuda"]
directml = ["ort/directml"]
default = ["cuda"]
```

**Server startup flow**:
1. Load models (same init as `src-tauri/lib.rs`)
2. Bind to `127.0.0.1:19284` (localhost only — security)
3. CORS: Allow `moz-extension://*` origin
4. Optional: system tray icon via `tray-item` crate (or just a CLI process)

---

### 2. Firefox Extension (Manifest V2)

**Location**: `extension/` (new directory in repo)

Firefox still fully supports Manifest V2, which gives us:
- Background scripts (persistent, not service workers)
- Full `webRequest` API without restrictions
- `fetch()` from background with no CORS issues to localhost
- Broader content script capabilities

#### 2a. Directory Structure

```
extension/
├── manifest.json
├── background.js            # Persistent background script
├── content.js               # Injected into manga sites
├── popup/
│   ├── popup.html           # Toolbar popup UI
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html          # Full settings page
│   ├── options.js
│   └── options.css
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── lib/
    └── constants.js          # Shared constants (API URL, etc.)
```

#### 2b. manifest.json

```json
{
  "manifest_version": 2,
  "name": "Koharu Manga Translator",
  "version": "0.1.0",
  "description": "Live manga translation powered by local AI models",

  "permissions": [
    "activeTab",
    "storage",
    "contextMenus",
    "<all_urls>"
  ],

  "background": {
    "scripts": ["background.js"],
    "persistent": true
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],

  "browser_action": {
    "default_icon": "icons/icon-48.png",
    "default_popup": "popup/popup.html",
    "default_title": "Koharu Translator"
  },

  "options_ui": {
    "page": "options/options.html"
  },

  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

#### 2c. Content Script (`content.js`)

Responsibilities:
- Listen for messages from background script
- Find and replace `<img>` elements with translated versions
- Add visual indicators (loading spinner overlay, translated badge)
- Right-click context menu integration

```
User clicks image / selects "Translate" from context menu
  → content.js reads the <img>.src
  → sends message to background.js: { action: "translate", imageUrl: "..." }
  → background.js fetches the image, sends to local server
  → background.js returns translated image as data URL
  → content.js replaces <img>.src with data URL
  → adds CSS class "koharu-translated" for visual indicator
  → stores original src for "Revert" functionality
```

Key implementation details:
- **Image detection**: Look for `<img>` elements whose `naturalWidth > 200` and
  `naturalHeight > 200` (skip tiny icons/avatars)
- **Loading state**: Overlay a semi-transparent div with a spinner on the image
  while translation is in progress
- **Revert**: Store `originalSrc` in a `WeakMap` keyed by the element. Double-click
  or context menu "Revert" restores it
- **Batch mode**: When enabled, scan all images on the page and translate them
  sequentially (with a queue in background.js)

#### 2d. Background Script (`background.js`)

Responsibilities:
- Manage connection to local Koharu server
- Handle translation requests from content script
- Cache translated images (in-memory LRU cache by URL hash)
- Context menu registration
- Server health monitoring

```javascript
// Pseudo-code for core translation flow
async function translateImage(imageUrl, tabId) {
  // 1. Check cache
  const cached = cache.get(imageUrl)
  if (cached) return cached

  // 2. Fetch original image
  const response = await fetch(imageUrl)
  const imageBlob = await response.blob()

  // 3. Send to local server
  const formData = new FormData()
  formData.append('image', imageBlob)

  const settings = await browser.storage.local.get([
    'translationProvider', 'apiKey', 'sourceLang', 'targetLang'
  ])

  const serverUrl = `http://127.0.0.1:19284/translate-image`
    + `?provider=${settings.translationProvider || 'google'}`
    + `&api_key=${settings.apiKey || ''}`
    + `&source=${settings.sourceLang || 'ja'}`
    + `&target=${settings.targetLang || 'en'}`

  const result = await fetch(serverUrl, {
    method: 'POST',
    body: formData
  })

  // 4. Convert to data URL for injection
  const translatedBlob = await result.blob()
  const dataUrl = await blobToDataURL(translatedBlob)

  // 5. Cache and return
  cache.set(imageUrl, dataUrl)
  return dataUrl
}
```

#### 2e. Popup UI (`popup/`)

Minimal toolbar popup:
- **Status indicator**: Green dot if server is running, red if not
- **Toggle**: Enable/disable auto-translation on current tab
- **Quick translate**: Button to translate all images on current page
- **Settings link**: Opens options page
- **Server info**: GPU status, model info (from `GET /status`)

#### 2f. Options Page (`options/`)

Full settings:
- Translation provider (Google / DeepL / Ollama)
- API keys
- Source/target language
- Server URL (default `http://127.0.0.1:19284`)
- Auto-translate settings (minimum image size, site allowlist)
- Cache settings (max size, clear cache button)
- Render method (LaMa / Rectangle Fill)

---

### 3. Shared Code Extraction (optional optimization)

To avoid duplicating logic between `src-tauri/commands.rs` and
`koharu-server/src/handlers.rs`, we can extract shared pipeline logic into a
`koharu-core` crate:

```
koharu-core/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── pipeline.rs       # Full translate-image pipeline
    ├── state.rs          # Model state management
    ├── text_renderer.rs  # Text rendering (from src-tauri)
    └── ocr_pipeline.rs   # OCR pipeline trait + impls
```

Both `src-tauri` and `koharu-server` would then depend on `koharu-core`:

```
comic-text-detector ─┐
manga-ocr           ─┼──► koharu-core ──┬──► src-tauri (Tauri desktop app)
lama                 ─┘                 └──► koharu-server (HTTP server)
```

This is an optimization, not a requirement. For the first version, duplicating
the thin adapter layer (~200 lines) is fine.

---

## Implementation Plan

### Phase 1: Local Server (branch: `extension-server`)

**Goal**: Standalone Rust HTTP server that can translate an image end-to-end.

1. **Create `koharu-server/` crate**
   - Add to workspace `Cargo.toml`
   - Set up `axum` with CORS for `moz-extension://*`
   - Copy model initialization from `src-tauri/lib.rs`
   - Implement `GET /health`

2. **Implement `/detect` endpoint**
   - Accept image as multipart upload
   - Call `comic_text_detector.inference()`
   - Return bboxes + mask as JSON

3. **Implement `/ocr` endpoint**
   - Accept image as multipart upload
   - Call OCR pipeline (MangaOCR or PaddleOCR)
   - Return recognized texts as JSON

4. **Implement `/inpaint` endpoint**
   - Accept image + mask as multipart upload
   - Call `lama.inference()`
   - Return inpainted image as PNG

5. **Implement `/translate-image` (full pipeline)**
   - Accept image as multipart upload + query params
   - Run: detect → crop regions → OCR → translate → inpaint → render text
   - Return fully translated PNG
   - This is the only endpoint the extension strictly needs

6. **Test with curl**
   ```bash
   # Health check
   curl http://127.0.0.1:19284/health

   # Full translation
   curl -X POST -F "image=@manga_page.png" \
     "http://127.0.0.1:19284/translate-image?provider=google&api_key=KEY" \
     -o translated.png
   ```

**Estimated effort**: 2–3 days. Most code is adapter logic wrapping existing
crate APIs.

### Phase 2: Firefox Extension (branch: `extension-firefox`)

**Goal**: Minimal extension that translates images via context menu.

1. **Scaffold extension directory**
   - `manifest.json`, icons, basic popup

2. **Implement background.js**
   - Server health check polling
   - `translateImage()` function
   - Context menu: "Translate with Koharu"
   - In-memory cache (Map with LRU eviction)

3. **Implement content.js**
   - Message listener for translation results
   - Image replacement with loading indicator
   - Revert functionality (store original src)

4. **Implement popup UI**
   - Server status indicator
   - "Translate all on page" button
   - Settings link

5. **Implement options page**
   - API key configuration
   - Language settings
   - Server URL override

6. **Test on manga sites**
   - pixiv.net
   - mangadex.org
   - raw.senmanga.com
   - Direct image URLs

**Estimated effort**: 2–3 days for basic functionality.

### Phase 3: Polish & Distribution

1. **Server packaging**
   - Build as standalone `.exe` with system tray
   - Auto-start option
   - Installer bundles models (or downloads on first run)

2. **Extension packaging**
   - Sign for Firefox Add-ons (AMO)
   - Or distribute as `.xpi` for sideloading

3. **UX improvements**
   - Progress indicator on images being translated
   - Batch translation with progress bar
   - Keyboard shortcut (e.g., `Alt+T` to translate selected image)
   - "Translate on hover" mode

4. **Performance**
   - WebSocket for streaming progress
   - Parallel OCR for multiple text blocks
   - Image result caching on disk

---

## Key Design Decisions

### Why localhost HTTP instead of Native Messaging?

Firefox supports [Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
where the extension communicates with a native app via stdin/stdout. We chose
HTTP instead because:

| Factor | Native Messaging | HTTP Server |
|--------|-----------------|-------------|
| Setup complexity | Needs registry key + JSON manifest | Just run the exe |
| Data transfer | stdin/stdout (1MB message limit) | No limit |
| Binary data | Must base64 encode (33% overhead) | Native multipart |
| Multiple clients | One extension per native app | Any client can connect |
| Debugging | Hard to inspect | `curl`, browser DevTools |
| Reusability | Firefox-only protocol | Any HTTP client (other browsers, scripts, etc.) |
| Bidirectional | Requires polling or complex framing | WebSocket upgrade available |

HTTP is simpler, faster for large images, and the server can be reused by other
tools (Chrome extension, CLI scripts, other apps).

### Why Manifest V2?

Firefox continues to support MV2 with no announced deprecation date. MV2 gives
us:
- **Persistent background scripts**: No service worker lifecycle complexity.
  The background script stays alive and maintains the cache, server connection,
  and context menus without re-initialization.
- **Unrestricted `fetch()`**: Background scripts can fetch from any URL including
  localhost without CORS issues (the background script runs in a privileged
  context).
- **Full `webRequest` API**: If we ever need to intercept image requests for
  auto-translation, MV2's blocking `webRequest` is far more capable than MV3's
  `declarativeNetRequest`.

If Firefox ever drops MV2, migrating to MV3 would mainly involve converting the
background script to a service worker and handling its lifecycle (the core
translation logic stays the same).

### Why not use WebAssembly in the extension?

Running ONNX models in WASM inside the extension was considered but rejected:
- **No GPU acceleration**: WASM has no CUDA/DirectML access. Inference would be
  10–50x slower (CPU only).
- **Memory limits**: Browser WASM has a 4GB memory limit. Large models +
  high-res images can exceed this.
- **Bundle size**: Shipping models inside the extension would make it 500MB+.
- **Startup time**: Loading ONNX models in WASM takes 10–30 seconds.

The local server approach gives us full GPU acceleration at native speed with no
bundle size penalty.

### Security Considerations

- Server binds to `127.0.0.1` only (not `0.0.0.0`) — no network exposure
- CORS restricted to `moz-extension://*` — only the extension can call it
- API keys stored in `browser.storage.local` (Firefox-encrypted storage)
- API keys sent as query params over localhost (never leaves the machine)
- No telemetry, no external connections except translation API calls

---

## File Changes Summary

### New files/directories:

```
koharu-server/                    # New crate
├── Cargo.toml
└── src/
    ├── main.rs                   # Server entry point, model init
    ├── handlers.rs               # HTTP endpoint handlers
    ├── state.rs                  # AppState (models behind Arc<Mutex>)
    └── pipeline.rs               # Full translate-image pipeline

extension/                        # Firefox extension
├── manifest.json
├── background.js
├── content.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── lib/
    └── constants.js
```

### Modified files:

```
Cargo.toml                        # Add koharu-server to workspace members
```

### Unchanged:

```
comic-text-detector/              # Used as-is by koharu-server
manga-ocr/                       # Used as-is by koharu-server
lama/                             # Used as-is by koharu-server
src-tauri/                        # Desktop app untouched
next/                             # Desktop frontend untouched
```

---

## Quick Start (after implementation)

```bash
# 1. Build and run the local server
cd koharu-server
cargo run --release --features cuda
# Server running on http://127.0.0.1:19284

# 2. Load the extension in Firefox
# Firefox → about:debugging → This Firefox → Load Temporary Add-on
# Select extension/manifest.json

# 3. Use it
# Right-click any manga image → "Translate with Koharu"
# Or click the toolbar icon → "Translate All on Page"
```

---

## Future Possibilities

- **Chrome extension**: Same server, different extension manifest (MV3 + offscreen document for fetch)
- **CLI tool**: `koharu translate manga.png -o translated.png` (calls same server)
- **Mobile**: Server runs on PC, phone browser extension connects over LAN
- **Batch processing**: `koharu batch ./manga-folder/ -o ./translated/`
- **WebSocket streaming**: Real-time progress updates for large images
- **Site-specific adapters**: Custom content scripts for pixiv, mangadex, etc.
  that understand the site's DOM structure for better image detection
