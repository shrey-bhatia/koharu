# Future Feature & Fix Plan

## Scope
- Stabilize how the active image/pipeline state is tracked so UI layers always reflect the correct source.
- Ensure rectangle overlays respect the selected render method across preview and export surfaces.
- Design a production-ready batch translation workflow that can process multi-page sets without manual repetition.

---

## 1. Displayed Image State Management Fix

### 1.1 Symptoms Observed
- Loading a new page leaves `pipelineStages.*`, `textBlocks`, and tool selection populated with the previous session, so Konva layers can render stale rectangles/text over the new bitmap.
- `currentStage` can remain on `final` even when the only valid asset is the freshly loaded original image; the preview falls back to `image.bitmap` but the UI still advertises derived stages.
- `pipelineStages.original` is never populated, making downstream logic rely on ad-hoc fallbacks and complicating future batch orchestration.
- `selectedBlockIndex`, `segmentationMask`, and `inpaintedImage` are not cleared, so panels like OCR/Inpaint show incorrect readiness states.

### 1.2 Root Cause Summary
- `setImage` only sets the image reference; it does not reset or repopulate ancillary state.
- Stage gating (buttons, canvas overlays) derives from `currentStage` and `pipelineStages` but lacks a single source of truth for "what is the active base image".
- The Konva layer toggle `shouldShowOverlays` checks only `tool` + `currentStage`, not whether the relevant stage assets match the render method.

### 1.3 Proposed Fix Strategy
1. **Introduce a dedicated `loadImageSession` action** in the editor store that:
   - Sets the new `image` and also writes it to `pipelineStages.original`.
  - Resets `pipelineStages.textless`, `.rectangles`, `.final`, `inpaintedImage`, `textBlocks`, `segmentationMask`, `selectedBlockIndex`, and `currentStage` to their initial states.
   - Resets tooling context to `tool = 'detection'` and `scale = 1` (with an optional `preserveScale` flag for power users).
2. Update `Topbar.handleOpenImage` to call `loadImageSession` instead of `setImage`, and memoize the previous blob to release resources if needed.
3. Audit all state setters that should be aware of the new lifecycle (e.g., detection should promote the original image into pipeline metadata only after successful load).
4. **Add single-source selectors**:
   - `getActiveBaseImage(stageOverride?)` encapsulates the fallback order so `canvas.tsx`, the render export pipeline, and future batch runners always agree on the active bitmap.
   - `getStageStatus(stage?)` exposes method-aware readiness so UI gating and test harnesses can share one source of truth.
5. Ensure `setPipelineStage` toggles `currentStage` to the newest completed stage only if it matches the active render method, enabling method-aware stage gating and preventing stale previews.

### 1.4 Implementation Tasks
- `next/lib/state.ts`
  - Add `loadImageSession` action and extend store reset helpers.
  - Persist `pipelineStages.original`, tighten stage typing (enum or discriminated union), and surface the new selectors.
- `next/components/topbar.tsx`
  - Swap `setImage` for `loadImageSession`, reset tool/stage buttons, and render labels based on `getStageStatus`.
- `next/components/canvas.tsx` & `next/components/render-panel.tsx`
  - Consume `getActiveBaseImage`/`getStageStatus` instead of duplicating fallback logic.
  - Gate overlay visibility via the selectors so preview/export stay in lockstep (ties into section 2).
- Tests
  - Add Jest unit coverage with a mocked Zustand store to confirm `loadImageSession` clears text blocks, masks, stages, and selections.
  - Ensure selectors surface method-aware availability for the stage buttons.

### 1.5 Validation & QA
- Manual smoke: load Page A → detect/translate → load Page B → confirm UI returns to detection state with no overlays from Page A.
- Automated: add a Jest suite that calls `loadImageSession` and asserts selector outputs across modes.
- Visual regression: create a Playwright flow that processes Page A (rectangle mode), then loads Page B. Assert cleared overlays via DOM checks and `expect(page).toHaveScreenshot('fresh-load.png', { maxDiffPixels: 10 })` so preview/export alignment stays provable.

---

## 2. Render Method Rectangle Overlay Behaviour

### 2.1 Current Behaviour & Gap
- Rectangular fill overlays are rendered whenever the render tool is active and `currentStage` is `rectangles` or `final`, regardless of the chosen `renderMethod`.
- Live preview therefore shows colored rectangles even for LaMa/NewLaMa modes, contradicting the intended experience (clean inpainted plate + translated text).
- Stage buttons allow switching to the `rectangles` view while in LaMa mode, where the stage conceptually has no meaning.

### 2.2 Planned Adjustments
1. **Overlay gating**: Extend `shouldShowOverlays` and the export pipeline to require `renderMethod === 'rectangle'` in addition to stage readiness.
2. **Stage availability rules**:
   - Hide or disable the `rectangles` stage selector when the active render method is LaMa/NewLaMa.
   - Auto-map `currentStage` to `textless` when AI modes are chosen and a textless plate exists; expose this via `getStageStatus`.
3. **Pipeline data hygiene**: Only persist `pipelineStages.rectangles` for rectangle mode; LaMa/NewLaMa should persist `textless` and `final` only to avoid stale reuse.
4. **Preview consistency**: Update Konva layers so AI modes render just the inpainted plate and translated text, never rectangles.
5. **UI feedback**: Surface a compact banner (“AI mode: rectangles hidden by design”) in Render panel when LaMa/NewLaMa is active to pre-empt confusion.

### 2.3 Implementation Tasks
- `next/components/canvas.tsx`
  - Gate the rectangle layer behind `renderMethod === 'rectangle' && getStageStatus('rectangles')`.
  - Ensure memoized derived state eliminates flicker when switching modes.
- `next/components/render-panel.tsx`
  - Only call `setPipelineStage('rectangles', …)` in rectangle mode.
  - When AI modes are active, switch to the textless plate, skip rectangle persistence, and render the informational banner.
- `next/components/topbar.tsx`
  - Build the stage button list from `getStageStatus`; hide/disable rectangles for AI modes and relabel `textless` as “Clean Plate”.
- Tests
  - Add Cypress/Playwright coverage verifying overlays toggle correctly per render method and that the banner appears for AI modes.
  - Retain manual regression: LaMa shows a clean plate; rectangle mode shows overlays.

### 2.4 Roll-Out Considerations
- Release note: “AI render modes now hide rectangles by design; rectangle fill mode retains overlays.”
- Optional analytics hook: track render-method switches post-change to ensure users understand the new gating.

---

## 3. Batch Translation Pipeline

### 3.1 Goals & Success Criteria
- Process multi-page sets end-to-end (Detection → OCR → Translation → Inpainting → Render/Export) without manual per-page intervention.
- Provide visibility into per-page progress, retries, and outputs, with resumability baked in.
- Avoid interfering with single-page editor state.

### 3.2 Architecture Overview
- **Session model**: Introduce a `BatchJob` composed of ordered `BatchPage` entries recording source path, stage status, timings, warnings, outputs, and manifest metadata.
- **State management**: Create an isolated Zustand slice (`useBatchStore`) exposing selectors for active job, queue status, percent complete, and resumability to keep the editor store clean.
- **Pipeline orchestrator**: Start with a front-end runner that enqueues GPU-bound LaMa calls with a queue size of **1**, while allowing optional parallelism (1–2 concurrent) for CPU-bound detection/OCR. Reuse existing Tauri commands and wrap them with retry/backoff logic. Revisit a Rust-side `batch_process_pages` command later for tighter control and telemetry.
- **Persistence**: Read images via Tauri FS APIs and write per-page JSON manifests capturing stage timings, bounding boxes, OCR text, translations, and render options. Store a job-level manifest index so runs can be resumed.

### 3.3 Frontend UX Plan
1. **Entry**: “Batch” button or tool opens a wizard to pick files/folders and configure render method, translation provider, concurrency, and output format.
2. **Dashboard**: Table/list showing thumbnail, filename, stage status, elapsed/ETA, and quick actions (retry, open output, view logs).
3. **Controls**: Start/Pause/Resume, Cancel job, Open output directory, Export manifest, Adjust translation delay.
4. **Detail drawer**: Selecting a page reveals per-stage logs, intermediate previews (textless, rectangles, final), and allows targeted reruns.
5. **Notifications**: Toasts or status bar messages for completion, failures, and warnings.

### 3.4 Orchestrator & Backend Enhancements
- Extend `src-tauri/src/state.rs` to ensure models stay warm across pages.
- If GPU contention emerges, promote the orchestrator to Rust so LaMa calls can be serialized natively and progress emitted via events.
- Keep translation provider flexibility: DeepL already rides backend commands; Google/Ollama continue via frontend fetch/invoke until Rust parity is needed.

### 3.5 Pipeline Flow (Per Page)
1. **Load source** → `createImageFromBlob` (frontend runner) or `fs.readBinaryFile` (backend orchestrator).
2. **Detection** → store bboxes + segmentation mask, log JSON for debugging, update manifest.
3. **OCR** → run sequentially, cache Japanese text, mark stale boxes cleared.
4. **Translation** → reuse provider-selected path; consult translation memory to skip duplicates.
5. **Inpainting** → call `inpaint_region` per block using batch-level presets; enforce LaMa queue size 1.
6. **Render** → reuse offscreen canvas, respect render method gating to avoid stale rectangles.
7. **Persistence** → write `output/page-001.png` and `output/page-001.json` (bboxes, mask stats, translations, timings, render config); update manifest index for resumability.

### 3.6 Error Handling & Resume
- Stage-level retries with exponential backoff and configurable max attempts.
- Mark pages as `failed` with actionable error messages; allow retrying individual stages or skipping while continuing the batch.
- On restart, load persisted manifests to resume incomplete pages automatically.

### 3.7 Performance & Constraints
- Enforce concurrency guardrails inside the orchestrator (LaMa queue size 1, detection/OCR max 2) with assertions and debug logging.
- Surface warnings when detection >5s, OCR >2s, or LaMa >20s to highlight hotspots.
- Add optional throttles between translation calls to respect provider quotas.

### 3.8 Telemetry & Logging
- Record per-stage timings, number of retries, and translation provider usage.
- Aggregate summary stats (avg timings, failure count) for the dashboard and manifest export.
- Optionally write a job-level log file for support scenarios.

### 3.9 Testing & Validation
- Add mock fixtures to run a small batch in CI for regression.
- Use Playwright to cover pause/resume/cancel flows, plus UI snapshots: `expect(page).toHaveScreenshot('batch-dashboard.png', { maxDiffPixels: 15 })` and `detail-drawer.png` to catch overlay regressions.
- Conduct manual load tests with 20–30 pages to ensure memory is released per page.

### 3.10 Milestones
1. **MVP**: Sequential processing, progress UI, output PNG + manifest.
2. **Beta**: Adds dashboard filters, translation memory, resumable jobs.
3. **Release**: Parallelism toggles, job manifest export, user-friendly error recovery, localization hooks.

---

## 4. Performance & Profiling Safeguards

### 4.1 Konva Layer Budget & Caching
- Keep the stage to **3–5 layers** (base image, optional rectangles, translated text, debug overlays).
- Group static overlays in `Group` nodes with `listening(false)` to avoid hit-testing cost.
- Disable `perfectDrawEnabled` where acceptable and memoize heavy shapes to limit redraw work on pan/zoom.

### 4.2 ONNX Runtime Profiling Access
- Add an “Open LaMa profiling report” button in the GPU status panel that opens the latest ONNX Runtime profiling JSON via Tauri shell.
- Provide a profiling toggle (off by default) that restarts inference with profiling enabled and warns users about the overhead before activation.

---

## Rollout Checklist
- Topbar uses `loadImageSession`, stage buttons honour method-aware availability, and `getActiveBaseImage` drives both preview and export.
- Rectangle overlays appear only in rectangle mode; AI modes show the inpainted plate plus the informational banner, and exports match preview per method.
- Batch MVP runs sequentially with resumable manifests, progress dashboard, retry tools, and respects concurrency guardrails.
- Playwright/Jest suites cover image session resets, overlay gating, batch dashboard snapshots, and profiling toggle visibility.

---

## Next Steps
- Review and refine the plan with maintainers.
- Once approved, implement sections 1 & 2 first (prerequisites for a robust batch workflow), then iterate on the batch feature with the defined guardrails and tests.
- Update documentation (`README`, `PIPELINE`, release notes) as features stabilise.
