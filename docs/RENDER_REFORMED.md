# Render Pipeline Deep Dive (Current vs. Desired)

## 1. What the in-app "Render" button actually does today

1. **`processColors()` (React side)**
   - Iterates every `textBlock` sequentially on the main thread.
   - For each block it:
     - Calls `extractBackgroundColor()` → allocates a fresh `OffscreenCanvas`, `drawImage()` for the full page, then samples a ring of pixels via `getImageData()` (one call per pixel). Results are median/variance statistics.
     - Falls back to appearance-analysis metadata if available.
     - Runs WCAG contrast adjustment (`ensureReadableContrast`).
     - Runs `calculateImprovedFontSize()` → classifies layout and brute-force searches font sizes 8–72 using `balancedLineBreak()` and `measureText()` on yet another transient `<canvas>` per measurement.
     - Appends updated block data and updates `setProgress()` every iteration (which triggers a React re-render per block).

2. **`generateFinalComposition()`**
   - Allocates an `OffscreenCanvas` sized to the original image.
   - Draws the base image (original, textless, or inpainted depending on render mode).
   - In rectangle mode, fills rounded rectangles for every block.
   - Draws translated text with `fillText`/`strokeText`, manually emulating letter spacing and word wrapping for each line.
   - Converts the canvas to a PNG (`convertToBlob`) and wraps it as an `ImageBitmap` (`createImageFromBuffer`).
   - Stores the result as the `pipelineStages.final` image.

3. **Konva preview (`next/components/canvas.tsx`)**
   - The stage’s base layer is whichever `pipelineStages.*` bitmap matches the selected stage.
   - When `tool === 'render'`, it *also* draws live Konva text nodes for editing (so the baked image and editable overlay coexist).
   - Konva uses HTML5 Canvas 2D; WebView2/Chromium hands the rasterization/compositing path to ANGLE, which routes through the Intel iGPU by default. CPU stays busy running the JS loops above.

## 2. Where the load lands (CPU vs. iGPU vs. dGPU)

| Step | Primary worker | Notes on acceleration |
|------|----------------|------------------------|
| `extractBackgroundColor` | CPU (main thread) | `getImageData` forces a GPU→CPU readback; repeated canvas creation prevents reuse of GPU resources. |
| `calculateImprovedFontSize` | CPU (main thread) | Re-creates a DOM canvas for each `measureText` call; no GPU use beyond tiny rasterization. |
| `setProgress` per block | CPU (React render) | Continuous state writes trigger layout/paint churn. |
| `generateFinalComposition` drawing | Intel iGPU + CPU | `drawImage` / `fillText` executed in Canvas 2D; ANGLE accelerates rasterization on the integrated GPU but still syncs with CPU for commands. |
| Konva preview | Intel iGPU + CPU | Same ANGLE-backed Canvas 2D context; iGPU compositing is why that adapter spikes. |
| PNG encode (`convertToBlob`) | CPU | Chromium’s PNG encoder is CPU-only. |

On Windows, WebView2 defaults to the **integrated GPU** for ANGLE contexts. Unless the OS or app manifest specifies “prefer high performance GPU,” the NVIDIA adapter stays mostly idle for 2D canvas workloads.

## 3. Hotspots & mistakes hurting render time

1. **Per-block OffscreenCanvas churn**
   - `extractBackgroundColor` redraws the entire page onto a brand-new canvas for every block, then calls `getImageData(1×1)` thousands of times. This thrashes GPU command buffers and leaks allocations until GC.
   - *Fix*: Instantiate one shared `OffscreenCanvas` per source image, cache `ctx` and the `ImageData` buffer once (`getImageData(outerBox)`), then index into the typed array.

2. **Synchronous pixel loops**
   - Sampling each pixel individually (`getPixel`) causes a JS → WASM bridge per pixel. Grab a `Uint8ClampedArray` slice and iterate in pure JS.

3. **Font sizing brute-force**
   - `calculateImprovedFontSize` scans ~32 font sizes per block. Each `measureText` call creates a new `<canvas>` and context, so for 100 blocks we spawn thousands of canvases.
   - *Fixes*:
     - Reuse a singleton measurement `OffscreenCanvasRenderingContext2D`.
     - Cache `measureText` results per `(fontSize, fontFamily, token)` and reuse during balanced line breaking.
     - Replace linear scan with binary search once penalty is monotonic within a range, or early exit when penalties start increasing.

4. **Progress updates on every iteration**
   - `setProgress((i + 1) / textBlocks.length)` mutates Zustand state on each loop; React rerenders panels even though progress bar needn’t update 60× per second. Batch updates or throttle.

5. **Full recomposition for every tweak**
   - Even tiny changes (e.g., manual color tweak in `RenderCustomization`) trigger a full `generateFinalComposition` run, redrawing the entire page and re-encoding PNG.
   - *Optimization*: Keep `pipelineStages.final` as the inpainted/textless base and rely on Konva overlays for preview. Only bake a flattened PNG on explicit export.

6. **PNG encode on the main thread**
   - `canvasToBlob` blocks until encoding finishes. Ship it to a Worker (`canvas.convertToBlob` + `postMessage`) or switch to `createImageBitmap` without re-encoding when we only need preview.

7. **Letter-spacing loop**
   - Per-character `measureText` inside `drawTextWithSpacing` is fine for short strings but spikes with multi-line translations. Cache glyph widths per `(font, char)`.

## 4. Immediate optimisation roadmap

| Priority | Change | Expected impact |
|----------|--------|-----------------| 
| High | Reuse a shared sampling canvas + cache `ImageData` for `extractBackgroundColor`. | Removes redundant `drawImage` calls, slashes GPU readbacks, improves CPU time by ~5–10× for pages with many bubbles. |
| High | Introduce measurement cache & binary search in `calculateImprovedFontSize`. | Cuts thousands of canvas allocations & layout computations; biggest CPU win. |
| Medium | Throttle `setProgress` updates (e.g., every 5 blocks) & batch state writes. | Reduces React churn and unnecessary repainting. |
| Medium | Defer PNG encoding and only materialise flattened image on export. | Keeps render preview instant; avoids duplicate draw during interactive edits. |
| Medium | Move heavy loops (`extractBackgroundColor`, font sizing) into a Web Worker. | Keeps UI responsive; allows eventual multi-threading. |
| Low | Cache glyph metrics for letter spacing and reuse per block. | Smooths long-paragraph rendering. |
| Low | Precompute block mask statistics on detection and reuse, instead of re-analysing in render stage. | Avoids repeated analysis when users tweak parameters. |

## 5. NVIDIA dGPU feasibility

- **Today**: WebView2 chooses ANGLE D3D11 on the *integrated* adapter unless Windows’ Graphics Settings or an application manifest (`<PreferExternalGPU>true</PreferExternalGPU>`) says otherwise. Our build ships with the default manifest, so the Intel iGPU remains the compositor.
- **What we can do**:
  1. Add the `<windows><preferExternalGPU>true</preferExternalGPU></windows>` flag in `tauri.conf.json > bundle > windows > app_manifest`. This hints Windows to run the WebView on the discrete GPU when available.
  2. Document that users can force “High performance” for `Koharu.exe` under **Settings → System → Display → Graphics**.
  3. Optionally pass WebView2 command-line arguments (`--disable-features=UsePreferredAngleD3D11`) to make ANGLE re-pick devices; however, Canvas 2D gains are limited because the bottleneck is JS, not rasterization.
- **Reality check**: Even on the NVIDIA GPU, the CPU-bound color extraction and font sizing dominate runtime. Moving to dGPU helps final compositing marginally but won’t fix slow processing unless we address the JS hotspots.

## 6. Summary

- The render pipeline is currently CPU heavy; the Intel iGPU spikes because Canvas 2D compositing is hardware-accelerated, but the true bottlenecks are our synchronous pixel harvesting and font sizing loops.
- Optimising canvas reuse, caching measurements, and batching state updates will provide larger wins than switching GPUs.
- Prefer keeping the preview dynamic via Konva overlays and only baking PNGs on demand; this removes the costliest step from the interactive loop.
- If discrete GPU usage is desired, adjust the Windows manifest and document OS graphics settings, but treat it as icing rather than the core fix.

Implementing the high-priority items should materially reduce render times and keep the UI responsive without requiring hardware changes.
