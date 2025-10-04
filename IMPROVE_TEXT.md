# Text Rendering Improvement Plan

## 1. Pipeline Snapshot

| Stage | Purpose | Backend Entry Point | Frontend Component(s) | State Fields / Outputs |
| --- | --- | --- | --- | --- |
| Detection | Locate text regions & produce segmentation mask | `src-tauri/src/commands.rs::detection` (comic-text-detector-onnx) | `next/components/detection-panel.tsx` | `textBlocks[]` (bbox + class), `segmentationMask` (1024×1024 grayscale) |
| OCR | Extract Japanese text | `src-tauri/src/commands.rs::ocr` (manga-ocr-onnx) | `next/components/ocr-panel.tsx` | `textBlocks[i].text`, `ocrStale` flags |
| Translation | Google Cloud Translation API | `next/utils/translation.ts`, `next/components/translation-panel.tsx` | `translateWithGoogle`, autosave editors | `textBlocks[i].translatedText` |
| Inpainting | Remove source text using LaMa variants | `src-tauri/src/commands.rs::inpaint_region` (lama-manga-onnx) | `next/components/inpaint-panel.tsx` | `inpaintedImage`, `pipelineStages.textless` |
| Render | Composite backgrounds + translated text | `next/components/render-panel.tsx` | Offscreen canvas export, `RenderCustomization` UI | `textBlocks[i].backgroundColor`, `textBlocks[i].textColor`, `fontSize`, etc. |

**Models used:**
- `mayocream/comic-text-detector-onnx` → text bounding boxes, class (0=dark lettering, 1=light lettering), segmentation mask.
- `mayocream/manga-ocr-onnx` → OCR text per cropped region.
- `mayocream/lama-manga-onnx` → Text removal (whole-page or localized crops).

## 2. Current Rendering Behaviour & Pain Points

- `extractBackgroundColor(image, textBlock, padding)` samples a ring around the bounding box on the original image to infer a single background color; it ignores the segmentation mask and assumes the border tone is representative. Text fill color is binary, derived from `textBlock.class` (black vs white only).
- `processColors()` in `render-panel.tsx` re-samples every block whenever the user clicks Process. It does **not** persist richer appearance metadata or leverage earlier stages.
- `ensureReadableContrast()` can override the sampled background/text colors to satisfy WCAG AA, which occasionally produces flat white/black results that deviate from stylistic intent.
- `calculateOptimalFontSize()` (`next/utils/font-sizing.ts`) performs a word-based binary search using naive Canvas measurements. Limitations:
  - Ignores actual glyph layout in the original bubble (no use of segmentation mask geometry, rotation, or curvature).
  - Struggles with tall/skinny regions (vertical Japanese text) because everything is forced into horizontal lines with uniform leading.
  - No attempt to balance line lengths, justify text, or adjust letter spacing automatically. Users must tweak sliders manually.

## 3. Preserving Source Colors & Optional Outlines

### 3.1 Data We Already Have
- Full-resolution original `ImageBitmap` (pre-inpaint).
- 1024×1024 segmentation mask describing text pixels.
- Bounding boxes per block.

### 3.2 Proposed "Appearance Analysis" Step (runs right after Detection)
1. **Mask Extraction**: For each `TextBlock`, resample the global segmentation mask into local coordinates. Reuse the mapping logic implemented in `utils/alpha-compositing::extractMaskRegion` (scale factors from original resolution → mask grid). Persist the per-block mask as a compact `Uint8Array` or summary stats to avoid repeated recomputation.
2. **Interior Sampling (Text Fill Color)**:
   - Dilate the mask slightly (1–2 px at mask resolution) to close gaps, then erode (~3 px) to isolate core text pixels and avoid halos.
   - Sample RGB values from the original image inside this eroded mask. Use k-means (k=2) or median clustering to handle multi-tone lettering while resisting screentone noise.
   - Store the dominant fill as `sourceTextColor`, plus a confidence score (variance / cluster separation). Keep a short palette (top 2 colors with percentages) for advanced rendering modes.
3. **Background Sampling**:
   - Instead of ring-based sampling alone, subtract the (dilated) mask from the bounding box to get cleaner background pixels. Blend with the existing ring method as a fallback when mask coverage is sparse.
   - Persist as `sourceBackgroundColor` (with palette + confidence), separate from `backgroundColor` (which can continue to respect manual overrides or WCAG corrections).
4. **Outline Detection (Optional Tier)**:
   - Create an outline shell by subtracting the eroded mask from a slightly dilated version. These pixels often correspond to stroke/outline colors.
   - Sample colors within the shell, compute the dominant outline color (`sourceOutlineColor`) and estimate stroke width in screen pixels (mask shell width mapped back to original resolution).
   - Flag low-confidence results when outline shell coverage is < N pixels; in such cases fall back gracefully (no outline applied).
5. **State & Persistence**:
   - Extend `TextBlock` with immutable fields (`sourceTextColor`, `sourceBackgroundColor`, `sourceOutlineColor`, `outlineWidthPx`, `appearanceConfidence`).
   - Add a `appearanceAnalyzed: boolean` flag to skip repeated sampling.
   - Store per-block mask stats (area, centroid, orientation) for reuse in text layout (see §4).
6. **Pipeline Integration**:
   - Trigger appearance analysis automatically at the end of Detection (or lazily on first call to `processColors()` if the mask is available). Cache results so the render stage simply copies source colors into mutable fields (`textColor`, `backgroundColor`), applying WCAG adjustments only when confidence is low or user overrides exist.

### 3.3 Rendering Updates
- **Canvas Export (`render-panel.tsx`)**:
  - Use stored `sourceTextColor`/`sourceBackgroundColor` as defaults, but keep current manual override flow.
  - When outline metadata exists, draw text with `ctx.lineWidth = outlineWidthPx`, `ctx.strokeStyle = rgb(sourceOutlineColor)`, `ctx.strokeText(line, ...)` before `fillText`. Ensure OffscreenCanvas supports outlines in Tauri (it does on modern Chromium runtimes).
  - For rectangle-fill mode, blend background rectangles using the sampled color palette. For LaMa-based modes, we can skip solid rectangles and rely on inpainted plates, but still apply outlines during text drawing.
- **Preview Layer (`canvas.tsx`)**: Konva's `<Text>` supports `stroke` & `strokeWidth`; mirror the outline appearance so UI matches export output.

### 3.4 Edge Cases & Fallbacks
- Tiny bubbles (< ~12 px height): skip outline detection; default to white fill + black stroke for readability.
- Low-contrast masks (variance below threshold): fall back to manual controls and highlight block in UI with a "low confidence color" badge.
- Multi-tone text (gradients, emphasis words): store palette to allow future gradient rendering, but initially choose the dominant tone and surface palette chips in customization panel for manual selection.

## 4. Smarter Auto-Resizing & Placement

### 4.1 Issues Observed
- Aspect-ratio mismatch: English translations often spill horizontally in tall, narrow balloons.
- Uniform line height & centering ignore original text alignment (top-aligned vertical stacks, angled sound effects, etc.).
- Binary search only targets width/height constraints; it ignores aesthetic factors like balanced line lengths, baseline alignment, and letter spacing coherence.

### 4.2 Geometry Analysis Stage
Leverage per-block mask data gathered in §3 to characterize each bubble:
1. **Orientation**: Apply PCA on mask pixel coordinates to determine principal axis (angle θ). Store `orientationDeg` and `eccentricity` (ratio of eigenvalues) to differentiate vertical vs horizontal flows.
2. **Text Coverage Metrics**: Compute mask area / bbox area, convex hull, and centroid offsets to understand where text sits inside the bubble.
3. **Curvature & Slant**: For highly slanted text, fit a rotated bounding box or detect if rotating by θ better aligns with text coverage. (Rotation support can be a later enhancement; see §4.5).

### 4.3 Layout Mode Selection
Based on metrics above, classify blocks into layout templates:
- **Horizontal Standard**: Low eccentricity, orientation near 0° → current word-wrapping with centered alignment, but adjust leading & padding dynamically.
- **Vertical-Narrow**: High eccentricity, orientation near 90°, bbox width << height → prefer narrower column width, allow more lines, increase line-height to mimic stacked text while keeping left-to-right reading order. Optionally rotate text 90° when `orientationDeg` > 60° and user opts in.
- **Angled / Slanted**: Orientation between 15°–60° → candidate for rotated text placement (phase 2), or at minimum adjust alignment (top-left vs center) to mimic original anchor.
- **Caption Blocks**: Low coverage, rectangular shapes near panel edges → treat as captions; prefer top-left alignment and less aggressive scaling.

Expose the inferred mode in the UI so users can override when heuristics misclassify.

### 4.4 Improved Fitting Algorithm
1. **Constraint Definition**: Derive both hard constraints (max width/height inside effective region) and soft targets (desired coverage ratio, e.g., fill 65–80% of mask area).
2. **Adaptive Word Breaking**: Implement balanced line breaking (Knuth–Plass or a simplified scoring search) that minimizes raggedness while respecting width constraints.
3. **Dynamic Letter Spacing & Leading**:
   - Calculate optimal leading from mask height / expected line count.
   - Adjust letter spacing slightly for narrow columns to increase readability.
   - Populate `fontSize`, `letterSpacing`, `lineHeight` (new field) returned by the fitter.
4. **Optimization Loop**: Instead of naive binary search, run a small iterative solver:
   - Start from baseline font size predicted from mask area and average glyph density (empirical constant).
   - Evaluate penalty function includes width overflow, height overflow, raggedness, and deviation from target coverage.
   - Use gradient-free search (e.g., ternary search on font size combined with dynamic line break) until penalty minimized.
5. **Baseline Alignment**: Determine vertical anchor (top/middle/bottom) from mask centroid vs bbox center. Place lines accordingly rather than always center-aligning.

### 4.5 Advanced Placement (Stretch Goals)
- **Rotation Support**: When orientation confidence is high, optionally rotate translated text to align with original direction (requires using Konva `rotation` and exporting via Canvas transforms).
- **Non-Rectangular Regions**: Use the mask polygon to clip text or compute a distance field for curved balloons. Initial pass can approximate with inset polygons to adjust padding per side.
- **Sound Effects (SFX)**: Identify blocks flagged as SFX (via detection class or future classifier) and offer stylized presets (bold fonts, larger stroke widths, rotation).

## 5. Implementation Roadmap

1. **Instrumentation & Ground Truth**
   - Add developer logging to dump per-block mask stats and sampled colors for a curated set of pages. Use this to tune thresholds before UI integration.
2. **Appearance Analysis Module**
   - Build `analyzeTextAppearance(image, mask, textBlocks)` utility (frontend) that returns enriched block metadata.
   - Wire it into Detection completion; persist results in Zustand store and surface confidences in the Render panel.
3. **Rendering Updates**
   - Update `processColors()` to reuse stored appearance data, only falling back to manual sampling when missing.
   - Implement outline drawing in export + Konva preview.
   - Expand customization UI to show detected colors/outline with reset buttons and confidence indicators.
4. **Enhanced Font Fitting (Phase 1)**
   - Implement geometry analysis + layout mode heuristic.
   - Replace `calculateOptimalFontSize` with new fitter returning font size, lineHeight, letterSpacing, alignment suggestions.
   - Update render/export + customization sliders to reflect new metrics (expose auto vs manual toggle).
5. **Advanced Layout (Phase 2)**
   - Introduce balanced line breaking and penalty-based optimization.
   - Add optional rotation handling (gated by feature flag until stability confirmed).
6. **QA & Regression Suite**
   - Create visual regression harness (save before/after composites) for representative manga pages.
   - Add automated unit tests around color sampler (synthetic images) and layout fitter (text fixtures with expected line counts/font sizes).

## 6. Open Questions & Considerations

- **Performance**: Color analysis and mask processing run on the frontend and may be heavy for large batches. Mitigations: reuse shared OffscreenCanvas, cache mask patches, throttle worker usage, or offload to a Web Worker.
- **Library Choices**: Evaluate tinycolor2 (for color distances) or implement lightweight utilities ourselves to avoid bloating bundle size.
- **User Overrides**: Decide how manual edits coexist with auto updates (e.g., lock auto application once user tweaks colors or layout unless they hit "Re-run Auto" per block).
- **Outline Confidence**: Need heuristics/thresholds to avoid adding outlines where none existed (e.g., plain white text on dark background). Possibly rely on detection class or mask edge thickness.
- **Rotated Text Export**: Ensure OffscreenCanvas export matches Konva rotation semantics; may require drawing rotated groups or using Path2D for accurate clipping.

---

This plan confines changes to dedicated appearance and layout modules while keeping existing pipeline stages intact. Once implemented, automated renders should better match original Japanese styling with minimal manual tweaking.
