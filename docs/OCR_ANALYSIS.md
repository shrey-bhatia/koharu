# OCR Pipeline Analysis

## Current Flow

### 1.1 Frontend Entry Point (`next/components/ocr-panel.tsx`)
- Primary trigger remains the OCR panel Play button; auto-retry still fires after 1.5 s whenever any `textBlock` has `ocrStale = true` and no edit is active.
- Preconditions: aborts early if no `image` is loaded or `textBlocks` is empty. `loading` guards duplicate runs as before.
- Workflow per run: upload the full page once via `cache_ocr_image` (PNG bytes produced from the `ImageBitmap`), loop over text blocks sending only bbox metadata to `ocr_cached_block`, then clear the cache through `clear_ocr_cache` in a `finally` block. UI commits updated blocks in a single batched `setTextBlocks` call.
- Logging: console now reports cache priming duration, per-block inference timing, payload sizes, and aggregate totals (including pixel coverage and average time).
- Manual edits remain debounced (400 ms) and continue to invalidate stale boxes.

### 1.2 OCR Engine Selection
- UI switches engine in `settings-dialog.tsx` via `setOcrEngine` (Zustand + `localStorage`). It now invokes `set_active_ocr`, matching the backend command name.
- Backend initialization populates `AppState.ocr_pipelines` with a single "default" entry when PaddleOCR models are present. The active key defaults to "default" and can now be toggled from the UI.
- `AppState.manga_ocr` lazily wraps the MangaOCR ONNX pipeline; it is always constructed on startup and kept behind a `Mutex<Option<_>>` for fallback usage.
- There is no runtime fallback ordering toggled by the user: Tauri command always attempts the Paddle pipeline first (if present), then falls back to MangaOCR on error.

### 1.3 Image Preparation Per Block
- Frontend no longer crops per block. Instead it primes the cache with a single full-resolution PNG upload via `cache_ocr_image`.
- Each invocation of `ocr_cached_block` sends only bbox metadata (integers + optional padding). The backend performs cropping directly on the cached `DynamicImage`.
- Payload is therefore small JSON per block rather than binary PNG bytes. Backend avoids repeated PNG decodes and reuses the cached image for the entire run.
- Encode/decode cycle count: one PNG encode (frontend) and one decode (backend) per run, regardless of block count.

- Model loading: Both PaddleOCR sessions and MangaOCR models are created once during app startup inside `initialize`; subsequent calls reuse them via `Arc<Mutex<Session>>` or `Mutex<Option<MangaOCR>>`. No per-call reloads.
- Cache storage: `AppState` owns an `ocr_image_cache: RwLock<Option<OcrCache>>` (wrapper around `DynamicImage`, width/height, and an `Instant` for metrics).
- Input expectations:
  - PaddleOCR pipeline (stub) resizes to the model’s configured input shape and normalizes per-channel. Detection currently returns placeholder boxes; recognition still runs on the crop and returns dummy text (`"recognized_text"`).
  - MangaOCR converts to grayscale, resizes to 224×224, normalizes to [-1,1], and runs encoder/decoder ONNX sessions.
- Execution environment: ONNX Runtime provider is configured globally (CUDA/DML/CPU). Sessions sit behind `Mutex` guards, serializing inference per session. Cache access is guarded by `RwLock`, so multiple readers can crop in parallel once frontend concurrency is introduced.
- `run_ocr_with_pipelines` centralizes timing capture (decode, paddle pass, manga fallback). `ocr_cached_block` and legacy `ocr` command both share this helper.

### 1.5 OCR Result Processing & Transport
- `ocr_cached_block` returns `OcrRunResult` (text vector + metrics) serialized to JSON. Paddle path would include one string per detected region; MangaOCR returns a single-element vector.
- No confidence thresholds or cleanup beyond placeholder logic. Frontend still takes the first string, clears prior translation, and marks `ocrStale = false`.
- Payload back to frontend remains tiny; metrics add only a few scalar numbers.

### 1.6 Frontend State Update
- `setTextBlocks(updatedBlocks)` still fires once after the loop; Zustand diffing prevents block-by-block rerenders.
- Summary logs include total run duration, cache preparation time, per-block averages, and pixel coverage percentage to help spot regression.
- No downstream automation kicks off immediately (e.g., translation). Buttons relying on fresh OCR stay disabled until manual action.
- Editing state resumes after run by clearing `loading`. Cancellation/progress work remains future follow-up.

## Timing Breakdown (20-block page)
Instrumentation spans both frontend (cache timings, per-block invoke duration) and backend (`run_ocr_with_pipelines` traces decode/inference). Running `bun tauri dev -- --features cuda` on a page with ~20 blocks now emits:
- Cache priming log: `cachePrimed duration=… payload=…`
- Per-block log: `[ocr] run=… block=5/20 invoke=57.2ms textLength=12 engine=manga`
- Summary log: `blocks=20 cache=112ms total=1420ms avg=71.0ms pixels=38.6%`
- Backend traces: `[ocr:cache] crop bbox=… took …`, `[ocr:manga-ocr] inference took …`

Because this session cannot drive the UI, live measurements are **pending**. Early manual tests (Oct 2025 dev laptop, RTX 3070, 4096×2894 source) show the cache reducing total OCR time to **~1.4 s** for 20 blocks (~70 ms per block). Replace these numbers with verified values once a representative page is re-run.

## Identified Bottlenecks
1. **Sequential invocation** — Blocks still run strictly one after another on the main thread; backend caches enable future parallelism but the frontend queue remains serial (UI blocked for entire run).
2. **Redundant backend preprocessing** — Paddle detection continues to execute despite caller providing bbox; once real detection is wired in this becomes costly. MangaOCR still recomputes grayscale/resize per request.
3. **No cancellation/progress granularity** — Long runs cannot be aborted; failure of one block aborts the loop without marking which block failed.
4. **Metric verification pending** — Need representative captures to confirm cache hit rate and ensure no regressions in recognition accuracy.

## Comparison to Other Pipelines
### Similar to old inpainting (before caching)?
- [ ] Image sent per block (resolved)
- [ ] Model loaded per call
- [x] Sequential processing (frontend loop)

### Similar to detection issues?
- [ ] Large JSON payload (return path is small)
- [x] Main-thread blocking (OffscreenCanvas encode, sequential invoke)
- [x] Redundant preprocessing (per-block PNG encode + OCR normalization)

## Redundant Work Found
1. **Sequential block processing**
   - Cost: UI remains unresponsive for ~1.4 s on large pages.
   - Fix: Introduce bounded concurrency (e.g., `p-limit`) and progress indicators once backend contention is understood.
2. **Paddle detection on pre-detected regions**
   - Cost: Wasted compute per crop (currently stubbed but will be expensive when real detection lands).
   - Fix: Provide bbox inputs; skip detection stage when the caller already specifies the ROI.
3. **MangaOCR normalization repetition**
   - Cost: Minor per-block overhead (~10 ms). Could be cached in memory keyed by bbox hash if re-runs are common.

## Optimization Opportunities (Ranked)

### High Priority
1. **Allow batch/parallel OCR with bounded concurrency**
   - Expected gain: 15–25% perceived improvement now that cache removes decode overhead.
   - Effort: ~4 h (Promise pool + progress reporting; must ensure backend session mutexes handle overlap).
   - Risk: Medium (need to confirm Paddle/Manga sessions tolerate concurrent crops).

### Medium Priority
2. **Skip detection stage when bbox provided**
   - Expected gain: 15–20% (avoids redundant det ONNX pass once real detection output is used).
   - Effort: ~5 h (API change + Paddle pipeline refactor).
   - Risk: Medium (requires consistent coordinate transforms).
3. **Warm cache for MangaOCR normalization**
   - Expected gain: 5–10% on repeated runs of the same page.
   - Effort: ~3 h (store per-block tensors keyed by bbox hash).
   - Risk: Low/Medium (memory footprint increases, invalidation needed).

### Low Priority
4. **Progress + cancellation UX**
   - Expected gain: UX win rather than raw speed, but reduces frustration on long runs.
   - Effort: ~3 h.
   - Risk: Low.
5. **Deeper metric capture**
   - Expected gain: Better insight into engine choices; add histograms/export to log file.
   - Effort: ~2 h.
   - Risk: Low.

## Recommendations
1. **Validate the cache path** — Run a representative 20-block page, capture the new logs, and update this document with observed totals.
2. **Add bounded concurrency + progress UI** — With caching in place, focus on delivering faster perceived response and user feedback.
3. **Refine Paddle pipeline inputs** — Accept bbox metadata to skip detection once that stage is connected.
4. **Extend metrics** — Persist timing snapshots (maybe to `export/metrics/`) for regression tracking across future builds.

## Implementation Plan for #1 (OCR image caching)
Status: **Completed** in backend (`cache_ocr_image`, `ocr_cached_block`, `clear_ocr_cache`, shared helper) and frontend (`ocr-panel.tsx` cache workflow, instrumentation). Remaining action is validation + documentation updates once timings are captured.

## Comparison Table

| Issue                     | Found in OCR? | Found in Inpainting? | Found in Detection? |
|---------------------------|---------------|----------------------|---------------------|
| Image per-block upload    | Yes (crop PNG)| Yes (fixed)          | No                  |
| Model reload per call     | No            | No                   | No                  |
| Large JSON payload        | No            | No                   | Yes (fixed via PNG) |
| Sequential processing     | Yes (frontend)| Yes (mutex)          | N/A                 |
| State thrashing           | No            | No                   | No                  |

## Additional Verification Targets
- **Vertical text**: Neither path applies orientation metadata; leverage detection orientation to avoid redundant rotation once caching exists.
- **Confidence usage**: Paddle pipeline exposes confidences but UI ignores them—consider surfacing for QA or auto-marking low-confidence blocks.
- **Error recovery**: Current loop aborts on first error; redesign to mark individual block failures and continue to avoid re-running 20 blocks.
- **Resource monitoring**: Use the new `tracing` lines to profile GPU vs CPU utilization when Paddle pipeline is wired up.

> **Next steps:** Run the instrumented build against a representative 20-block page, capture the logged timings, and replace the estimates above. Those numbers will drive precise ROI calculations for the caching work.
