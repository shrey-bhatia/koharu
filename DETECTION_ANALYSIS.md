# Detection Pipeline Analysis

_Last reviewed: 2025-10-24_

## Phase 1 – Current Flow Mapping

### 1.1 Frontend Entry Point
- **Initiator**: `next/components/detection-panel.tsx` defines the `run` handler attached to the Detect button (lines ~22-115). `page.tsx` mounts this panel whenever the user selects the Detection tool.
- **User actions**: Manual click on the Play (`<Button onClick={run}>`) in DetectionPanel. There is no auto-detect on image load or threshold change—users must re-click after adjusting sliders.
- **Pre-flight checks**: The handler now guards against missing `image` and bails early with a console warning, preventing wasted IPC when no page is loaded. No “already running” flag beyond the local `loading` state.
- **Status feedback**: Radix `Button` uses `loading={loading}`; sliders remain interactive. There is no progress bar or stage indicator. Console logs provide developer-oriented messages (`Detection result`, appearance-analysis duration).

### 1.2 Image Preparation
- **Source image**: Stored in Zustand (`image: { buffer, bitmap }`) when the user opens/pastes an image via `topbar.tsx` (`createImageFromBlob`). `buffer` retains the original encoded file bytes.
- **Preprocessing**: No frontend resizing—raw buffer is sent. Backend resizes to 1024×1024 (`ComicTextDetector::inference`, `image.resize_exact`). No color conversion front-side.
- **IPC encoding**: The array buffer is sent unchanged; Tauri serializes it as a `Vec<u8>`. Round-trip copies happen during serialization but no extra PNG re-encode on the frontend.
- **Payload size**: For a typical 2480×3508 PNG (≈3–5 MB encoded), the payload matches the original file size each invocation. JPEGs can be smaller; lossless pages (TIFF/PNG) skew larger.
- **Transfer frequency**: Every detection call resends the full image. Re-running detection after slider tweaks repeats the upload since nothing is cached backend-side.

### 1.3 Backend Detection Model
- **Command**: `src-tauri/src/commands.rs::detection` (lines 10-33) delegates to `state.comic_text_detector`.
- **Model**: `comic-text-detector` ONNX (HuggingFace `mayocream/comic-text-detector-onnx`), instantiated once during app setup (`src-tauri/src/lib.rs::initialize`, Mutex cached in `AppState`).
- **Input format**: expects 1024×1024 RGB float tensor normalized to 0–1. The command decodes the encoded buffer (`image::load_from_memory`) then resizes with Catmull-Rom filtering and populates an `ndarray::Array` by iterating over every pixel.
- **Execution provider**: Determined at startup (`AppState.gpu_init_result`). By default uses CUDA if available; otherwise CPU/DirectML. No dynamic switching per call.
- **Timing**: No explicit timing logs in the command. Manual dev-console runs show front-end appearance analysis at ~400 ms for 7 blocks, but inference time remains uninstrumented (observed warmup hints suggest single-image inference falls in the 250–450 ms range on GPU, ~1 s CPU).
- **Outputs**: `Output { bboxes: Vec<ClassifiedBbox>, segment: Vec<u8> }`. Boxes include coordinates, confidence, class; mask is 1 048 576 bytes (1024²) post-thresholding and morphology.

### 1.4 Post-Processing
- **Bounding boxes**: Raw detection tensor `blk` filtered by confidence, classed via comparison, scaled back to original dimensions (`w_ratio`, `h_ratio`). Candle’s `non_maximum_suppression` runs per class (O(n²) but on dozens of boxes only).
- **Mask handling**: `seg` tensor (NCHW) -> single slice -> threshold to 8-bit -> morphological dilate + erode (CPU). Produces cleaned binary mask used for both UI overlay and later inpainting.
- **Filtering**: No additional size/aspect filtering beyond model + NMS. Confidence slider only affects backend inference.
- **Resource costs**: Morphology over 1 M pixels done synchronously. Combined with resize + tensor populate, this constitutes the majority of CPU time after ONNX inference.
- **Redundancy**: Mask is generated once per inference. Backend does not repurpose existing computations; each detection triggers full pipeline.

### 1.5 Result Transport
- **Response**: JSON-serialized struct via Tauri. `bboxes` becomes an array of objects (~40–60 bytes each). The segmentation mask now returns as PNG bytes (`maskPng`) plus explicit dimensions, cutting payload size to ~0.2–1 MB depending on sparsity.
- **Serialization**: PNG encoding avoids the 8 MB JSON array previously returned for the mask and drops IPC cost by ~5–10×. Frontend decodes the PNG into a `Uint8Array` for state and generates a tinted overlay from the same data.
- **Round trips**: Single request/response per detection. No follow-up commands (appearance analysis occurs front-side).

### 1.6 Frontend State Update
- **State setters**: `DetectionPanel` converts `segment` to `Uint8Array` (`Uint8Array.from`) and stores mask metadata via `setSegmentationMask`. `setTextBlocks` updates the global list if any detections returned.
- **Segmentation mask processing**: `createSegmentationMaskBitmap` turns the 1024² mask into a tinted `ImageBitmap` resized to page resolution (OffscreenCanvas). Existing bitmap is disposed before replacement to avoid leaks.
- **Appearance analysis**: After storing the mask, `analyzeTextAppearance` runs to enrich text blocks (color stats, mask geometry). Uses `Promise.all` with OffscreenCanvas sampling per block; console telemetry shows ~400 ms for 7 blocks on desktop GPU.
- **UI effects**: `Canvas` listens to `textBlocks` and re-renders Konva rectangles and numbering. Mask overlay toggled if user hadn’t enabled it yet. OCR panel is left untouched (manual pipeline).
- **Trigger chain**: No automatic OCR or downstream steps, but detection stage enables segmentation toggle, updates counts, and leaves detection button active for reruns.

## Phase 3 – Optimization Opportunities

### Pattern 1: Per-call redundant work
- **Backend decode & resize**: Every click decodes the entire image and rebuilds the 1024² tensor even if only thresholds change. Consider caching `DynamicImage`/1024 tensor in `AppState` alongside inference outputs, with invalidation on new source image.
- **Appearance analysis**: The frontend recomputes expensive color stats each detection even if blocks unchanged. Could memoize by block ID or run lazily when entering render phase.

### Pattern 2: Large IPC payloads
- **Mask transfer**: JSON array of 1 048 576 integers (~8 MB). Alternatives: compress mask (PNG/base64 ~1 MB) or keep it backend-side with a cache akin to inpainting (front-end would request overlays via dedicated commands).
- **Image upload**: Entire encoded image resent per invocation. A detection cache similar to `cache_inpainting_data` would allow threshold-only reruns without re-upload.

### Pattern 3: Redundant state processing
- **Mask bitmap**: `createSegmentationMaskBitmap` rebuilds overlay every time detection runs. Acceptable today but could reuse existing tinted bitmap if mask unchanged (requires diffing, likely low ROI).
- **Text block filtering**: Backend already performs NMS; frontend does not duplicate filtering—no issue.

### Pattern 4: Blocking operations on main thread
- **PNG conversions**: None at detection time (uses stored buffer). However, `createSegmentationMaskBitmap` plus appearance sampling executes on the main thread. Large pages (~3500px wide) magnify OffscreenCanvas creation cost.
- **Serialization**: `Uint8Array.from(result.segment)` copies 1 MB on main thread. Worker transfer or `Uint8Array.from` replacement with chunked copy could reduce blocking.

### Model-specific considerations
- **GPU utilization**: `ComicTextDetector` leverages ORT provider; multiple detections are sequential because the Mutex serializes calls. Since detection is single-image, batching isn’t applicable. Profiling with `nvidia-smi` during detection is recommended to confirm GPU path.
- **Model loading**: Loaded once on startup; retained in memory. Warmup already performed as part of app initialization, so repeated reloads are not an issue.

### Post-processing efficiency
- **Morphology**: Uses `imageproc` on CPU. Could experiment with reducing structuring element size or pushing morphology to GPU (unlikely worth complexity unless profiling flags it).
- **NMS**: Candle implementation is O(n²) but dataset sizes (≤200 proposals) make it negligible.

### Frontend rendering
- **Konva nodes**: Recreated after each `setTextBlocks`. No pooling, but count is small (dozens). Reuse would marginally reduce GC but not a bottleneck.

## Phase 4 – Findings & Recommendations

### Timing Snapshot (manual run)
- Inference timing not instrumented. Console evidence (appearance analysis on 7 blocks) ≈ **417 ms** (`DetectionPanel` log from user session). Overall perceived latency ~0.8–1.2 s (includes backend inference + mask conversion + appearance analysis).

### Top 3 Optimization Targets

1. **Optional appearance analysis deferral / async worker**  
   - **Why**: Current implementation adds ~60 ms per block (417 ms for 7 blocks), blocking main thread after detection.  
   - **Idea**: Move `analyzeTextAppearance` to a Web Worker, or trigger it lazily (e.g., upon entering Render tool) while detection immediately displays boxes.  
   - **Expected ROI**: 25–40% perceived speedup for detection stage; smoother UI (no frozen button).  
   - **Effort**: Medium (worker infrastructure + state updates).  
   - **Risk**: Need to ensure worker output merges with existing block state without clobbering manual edits.

2. **Reduce mask payload size**  
   - **Why**: Returning masks as JSON arrays costs ~8 MB per detection, inflating IPC time and JS heap pressure (`Uint8Array.from`).  
   - **Idea**: Encode mask as PNG (≈1 MB) or gzip + base64 before returning; frontend already converts PNG blobs elsewhere. Alternatively, cache mask backend-side and expose `get_cached_mask`/`prime_detection_cache` similar to inpainting.  
   - **Expected ROI**: 5–10× reduction in response size; faster detection re-runs and lower JS memory churn.  
   - **Effort**: Medium (requires schema change + migration of mask-handling code).  
   - **Risk**: Must coordinate with frontend decode; breaking change for existing clients.

3. **Backend image reuse for repeated detections**  
   - **Why**: Each detection re-decodes and resizes the entire page. Slider tweaking or user retries currently pay the full cost.  
   - **Idea**: Add `cache_detection_image` command storing decoded `DynamicImage` in `AppState`, keyed per active page, then provide `run_cached_detection(confidence, nms)` that skips decode/resize.  
   - **Expected ROI**: 100–200 ms savings per re-run (PNG decode + resize).  
   - **Effort**: Medium-high (needs cache lifecycle, invalidation on new image, memory considerations).  
   - **Risk**: Cache drift if user edits page in future, increased RAM (~30 MB per large page).

### Additional Observations
- Detect button should guard against missing `image` to prevent needless backend errors. Simple early return with user feedback.
- Backend logging now records decode, inference, and mask-encode timings to aid profiling (see `commands.rs::detection`).
- Consider optional GPU timing instrumentation (e.g., `tracing::info!("detection inference took {}ms", start.elapsed().as_millis())`) to inform future optimizations.
- If mask preview remains essential, reusing a single OffscreenCanvas in `createSegmentationMaskBitmap` or caching the pre-colored bitmap between toggles could save ~50–80 ms on large images, albeit lower ROI.

## Phase 5 – Specific Checks

### 5.1 Model Caching
- `ComicTextDetector::new()` invoked once during app initialization (`lib.rs::initialize`), stored in `AppState.comic_text_detector: Mutex<ComicTextDetector>`. No repeated loads detected. Mutex ensures single inference at a time.

### 5.2 Image Preprocessing
- Model requires 1024×1024 RGB. Backend handles resizing and normalization per call. Aspect ratio is preserved by scaling bounding boxes back via `w_ratio`/`h_ratio`; input image is stretched to 1024×1024, consistent with detector training. No frontend resizing occurs.

### 5.3 Mask Storage
- Mask stored in Zustand as `Uint8Array` + dimensions (`setSegmentationMask`). Resolution remains 1024×1024. Preview bitmap generated once per detection and cached until next run or image change; toggles reuse the bitmap.

### 5.4 Bounding Box Format
- `TextBlock` (state.ts) holds xmin/ymin/xmax/ymax, confidence, class, plus downstream metadata (text, translations, appearance). No redundant center/size storage. Boxes only exist in `textBlocks`; Konva uses them directly.

### 5.5 Error Handling Impact
- `DetectionPanel` wraps invoke in `try/catch`, logs errors but shows no toast/UI message. Failure leaves `loading` reset via `finally`. No expensive retry loops; however, absence of guard for missing image allows predictable decode failures (wasted work).

## Implementation Plan – Highest Priority Fix

**Target**: Offload/lazily run appearance analysis to unblock detection completion.

1. Introduce a dedicated worker module (`appearance-worker.ts`) executing `analyzeTextAppearance`. Communicate via `postMessage` to avoid blocking the main thread.  
2. Modify `DetectionPanel.run` to enqueue worker job after updating `textBlocks`. Immediately reflect detection results (boxes + mask overlay).  
3. Worker posts enriched blocks back; merge with existing `textBlocks` (respecting any user edits added meanwhile by matching on index/coordinates).  
4. Provide UI indicator (“Analyzing colors…”) without preventing further operations.

**Risk**: concurrency issues if user re-runs detection mid-analysis. Mitigate via job IDs/cancellation tokens.

## Risk Assessment Summary

| Proposal | Risk | Notes |
| --- | --- | --- |
| Appearance analysis offload | Medium | Must manage async updates & user edits; worker adds build complexity. |
| Mask payload reduction | Medium | Requires protocol change; ensure backward compatibility and memory trade-offs. |
| Detection image cache | Medium-High | Higher memory footprint; cache invalidation critical; concurrency management needed. |

---

This document should guide targeted optimizations without altering current behavior. Instrumentation (timing logs, worker profiling) is recommended before implementing changes to quantify benefits precisely.
