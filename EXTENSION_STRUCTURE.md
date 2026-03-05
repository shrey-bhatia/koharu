# Koharu Firefox Extension — Architecture Plan

## Overview

A Firefox extension that live-translates manga images in the browser, powered by
the same Rust/ONNX models that run in the Koharu desktop app. The extension
communicates with an HTTP server **embedded inside the existing Tauri app** —
no separate binary needed.

**Key design goals**:
- Maximum code reuse — same model instances, same translation providers
- Hover-to-translate with in-memory caching (re-hover = instant)
- Public CSS class API (`koharu-translate`) for ViolentMonkey/Greasemonkey scripts
- Provider-agnostic: all existing providers + local NMT models (ONNX-only)

---

## Design Decisions (from Q&A)

| Decision | Choice |
|----------|--------|
| Server hosting | Embedded in Tauri app (toggle in settings + minimize to tray) |
| Server port | Configurable (default 19284) |
| Translation trigger | Right-click menu + toolbar button + hover overlay (all configurable) |
| Hover behavior | Auto-translate on hover, revert on unhover, **cache** translated image |
| Caching | Memory-only in extension (lost on restart) |
| Save translated | Right-click "Save Koharu translated image" context menu |
| Public API marker | CSS class `koharu-translate` on any `<img>` |
| ViolentMonkey support | Document the CSS class API; extension watches for marked elements |
| Open-in-new-tab | Settings toggle: auto-translate when only an image is on the page |
| Model files | Share with desktop app (same loaded instances) |
| Local NMT | ONNX-only — JParaCrawl, OPUS-MT, NLLB-200, mBART-50 as options |
| Config/keys | Share with desktop app |
| Target sites | gelbooru, pixiv, kemono, twitter/x |
| Extension manifest | MV2 (persistent background scripts, unrestricted fetch) |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────┐
│              Firefox Browser                │
│                                             │
│  ┌───────────────┐    ┌──────────────────┐  │
│  │ Content Script │    │   Popup / UI     │  │
│  │ (page inject)  │    │ (toolbar popup)  │  │
│  │                │    └────────┬─────────┘  │
│  │ • hover overlay│             │            │
│  │ • CSS class    │             │            │
│  │   watcher      │    ┌────────┴─────────┐  │
│  │ • img swap     │    │   Background.js  │  │
│  └───────┬────────┘    │                  │  │
│          │ message     │ • translate queue │  │
│          └────────────►│ • memory cache   │  │
│                        │ • context menus  │  │
│                        └────────┬─────────┘  │
└─────────────────────────────────┼────────────┘
                                  │ HTTP POST
                                  ▼
              ┌────────────────────────────────┐
              │      Koharu Desktop App        │
              │      (Tauri + embedded axum)   │
              │                                │
              │  ┌── HTTP Server ──────────┐   │
              │  │ POST /translate-image   │   │
              │  │ GET  /health            │   │
              │  │ GET  /config            │   │
              │  └─────────┬───────────────┘   │
              │            │ shares models     │
              │  ┌─────────┴───────────────┐   │
              │  │ AppState (Arc<Mutex>)    │   │
              │  │ comic-text-detector     │   │
              │  │ manga-ocr / paddle-ocr  │   │
              │  │ lama                    │   │
              │  └─────────────────────────┘   │
              └────────────────────────────────┘
```
