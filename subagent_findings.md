Koharu Rust Backend — Comprehensive Analysis
1. State Management (state.rs)
Fields & Types
Field	Type	Sync Primitive	Purpose
comic_text_detector	ComicTextDetector	Mutex	Text detection model
lama	Lama	Mutex	Inpainting model
gpu_init_result	GpuInitResult	Mutex	GPU initialization status
ocr_pipelines	HashMap<String, Arc<dyn OcrPipeline>>	RwLock	Multiple OCR engines
active_ocr	String	RwLock	Currently selected OCR engine key
inpaint_image_cache	Option<Arc<DynamicImage>>	RwLock	Cached full image for inpainting
inpaint_mask_cache	Option<Arc<GrayImage>>	RwLock	Cached mask for inpainting
ocr_image_cache	Option<Arc<DynamicImage>>	RwLock	Cached full image for OCR
State Design Assessment
Good decisions:

RwLock for caches and ocr_pipelines — multiple reads can proceed in parallel
Arc wrapping cached images — avoids cloning large image buffers
Mutex for models — ONNX sessions are not reentrant; serialized access is correct
2. Tauri Commands Inventory
2.1 detection (line 114)
Signature: async fn detection(app, image: Vec<u8>, confidence_threshold: f32, nms_threshold: f32) → DetectionResult
Purpose: Runs comic text detection model. Returns bounding boxes + segmentation mask as PNG.
Frontend usage: detection-panel.tsx
2.2 ocr (line 180)
Signature: async fn ocr(app, image: Vec<u8>) → Vec<String>
Purpose: Full-image OCR (legacy path). Decodes image, runs active pipeline.
Frontend usage: Not directly used by frontend anymore (replaced by cached path).
2.3 cache_ocr_image (line 209)
Signature: async fn cache_ocr_image(app, image_png: Vec<u8>) → ()
Purpose: Primes the OCR image cache. Frontend sends image once, then calls ocr_cached_block per bbox.
Frontend usage: ocr-panel.tsx
2.4 clear_ocr_cache (line 235)
Signature: async fn clear_ocr_cache(app) → ()
Frontend usage: ocr-panel.tsx
2.5 ocr_cached_block (line 250)
Signature: async fn ocr_cached_block(app, bbox: BBox) → Vec<String>
Purpose: Crops a region from cached image, runs OCR on it.
Frontend usage: ocr-panel.tsx
2.6 set_active_ocr (line 349)
Signature: async fn set_active_ocr(app, model_key: String) → ()
Frontend usage: settings-dialog.tsx
2.7 inpaint (line 375) — DEPRECATED
Signature: async fn inpaint(app, image: Vec<u8>, mask: Vec<u8>) → Vec<u8>
Purpose: Full-image inpainting (legacy). Marked #[deprecated].
Frontend usage: None (confirmed by search).
2.8 get_system_fonts (line 401)
Signature: fn get_system_fonts() → Vec<String> (SYNC)
Purpose: Enumerates system font families.
Frontend usage: settings-dialog.tsx, render-customization.tsx
2.9 cache_inpainting_data (line 777)
Signature: async fn cache_inpainting_data(app, image_png: Vec<u8>, mask_png: Vec<u8>) → ()
Frontend usage: inpaint-panel.tsx
2.10 inpaint_region_cached (line 806)
Signature: async fn inpaint_region_cached(app, bbox, padding?, debug_mode?, config?) → InpaintedRegion
Frontend usage: inpaint-panel.tsx
2.11 clear_inpainting_cache (line 843)
Signature: async fn clear_inpainting_cache(app) → ()
Frontend usage: inpaint-panel.tsx
2.12 inpaint_region (line 862)
Signature: async fn inpaint_region(app, image: Vec<u8>, image_width, image_height, mask: Vec<u8>, mask_width, mask_height, bbox, padding?, debug_mode?, config?) → InpaintedRegion
Purpose: Legacy non-cached inpainting path. Still registered but frontend uses cached path.
Frontend usage: None found (frontend uses cache_inpainting_data + inpaint_region_cached).
2.13 set_gpu_preference (line 1059)
Signature: fn set_gpu_preference(app, preference: String) → () (SYNC)
Frontend usage: settings-dialog.tsx
2.14 get_gpu_devices (line 1085)
Signature: fn get_gpu_devices() → Vec<GpuDevice> (SYNC)
Frontend usage: None found.
2.15 get_current_gpu_status (line 1115)
Signature: fn get_current_gpu_status(app) → GpuInitResult (SYNC)
Frontend usage: render-panel.tsx, gpu-status-panel.tsx
2.16 run_gpu_stress_test (line 1132)
Signature: async fn run_gpu_stress_test(app, iterations?, target_size?) → StressTestResult
Frontend usage: gpu-status-panel.tsx
2.17 translate_with_deepl (line 1218)
Signature: async fn translate_with_deepl(api_key, text, use_pro, source_lang?, target_lang?) → String
Frontend usage: translation.ts
2.18 translate_with_ollama (line 1316)
Signature: async fn translate_with_ollama(text, model, system_prompt?) → String
Frontend usage: translation.ts
2.19 render_and_export_image (line 1392)
Signature: async fn render_and_export_image(request: RenderRequest) → Vec<u8>
Frontend usage: render-panel.tsx
Not registered but exists in code:
verify_image_routing in commands/render.rs — not registered in invoke_handler, not called by frontend.
3. Issues by Severity
CRITICAL
3.1 blocking_lock() in sync Tauri command on async runtime
File: commands.rs

pub fn get_current_gpu_status(app: AppHandle) -> CommandResult<crate::state::GpuInitResult> {
    let state = app.state::<AppState>();
    let init_result = state.gpu_init_result.blocking_lock();
    Ok(init_result.clone())
}
Impact: blocking_lock() on a tokio::sync::Mutex blocks the current thread. Since Tauri sync commands run on the async runtime's thread pool, this can deadlock if the mutex is held by another task on the same runtime, or starve other async tasks. This is the textbook "blocking_lock() inside async runtime" anti-pattern.

Fix: Make this command async and use .lock().await, or change gpu_init_result from Mutex to RwLock (it's read-only after init):

pub async fn get_current_gpu_status(app: AppHandle) -> CommandResult<...> {
    let state = app.state::<AppState>();
    let init_result = state.gpu_init_result.lock().await;
    Ok(init_result.clone())
}
HIGH
3.2 get_system_fonts() is synchronous and does I/O
File: commands.rs

#[tauri::command]
pub fn get_system_fonts() -> CommandResult<Vec<String>> {
    let source = SystemSource::new();
    let mut fonts = source.all_families()...
Impact: SystemSource::all_families() scans font directories on disk — this is I/O-bound work that blocks the calling thread. On Windows with many fonts this can take 100ms+. Running synchronously on Tauri's IPC thread blocks all other command processing.

Fix: Make async + spawn_blocking:

pub async fn get_system_fonts() -> CommandResult<Vec<String>> {
    tokio::task::spawn_blocking(|| {
        let source = SystemSource::new();
        let mut fonts = source.all_families()?;
        fonts.sort();
        Ok(fonts)
    }).await?
}
3.3 get_gpu_devices() is synchronous with wgpu enumeration
File: commands.rs

pub fn get_gpu_devices() -> CommandResult<Vec<GpuDevice>> {
    let instance = Instance::new(...);
    let adapters = instance.enumerate_adapters(Backends::all());
Impact: Same pattern — wgpu adapter enumeration involves driver calls that can block. Also, this command is never called by the frontend, making it dead code.

3.4 ONNX model inference runs directly on async task, not spawn_blocking
File: commands.rs

let output = state
    .comic_text_detector
    .lock()
    .await
    .inference(&img, confidence_threshold, nms_threshold)
    .context("Failed to perform inference")?;
Same issue at line 759 for LaMa inference:

let inpainted_crop = state
    .lama
    .lock()
    .await
    .inference_with_size(&cropped_image, &mask_dynamic, cfg.target_size)
And line 382-386 for the deprecated inpaint command.

Impact: ONNX inference is CPU-bound work (even with CUDA — the thread blocks waiting for GPU completion). This ties up a tokio worker thread for potentially seconds. The initialize() function in lib.rs correctly uses spawn_blocking for warmup but the actual command handlers do not.

Fix: Wrap inference in spawn_blocking. This requires restructuring since models are behind tokio::sync::Mutex, so you'd need to acquire the lock, then move the guard into the blocking task (or use std::sync::Mutex instead).

3.5 Deprecated inpaint command still registered
File: lib.rs — invoke_handler list does NOT include inpaint, so this is actually fine. But the function still exists in commands.rs with #[deprecated] and #[tauri::command] annotations. The command macro still generates code for it even though it's unused — minor code bloat.

3.6 Duplicate RenderRequest struct and render_and_export_image command
Files: commands.rs AND commands/render.rs

Both files define:

struct RenderRequest with identical fields
async fn render_and_export_image with near-identical logic
The one in commands.rs uses CommandResult<Vec<u8>> with anyhow, the one in render.rs uses Result<Vec<u8>, String>. Only the commands.rs version is imported in lib.rs. The render.rs version is dead code along with verify_image_routing.

MEDIUM
3.7 gpu_init_result uses Mutex but is effectively read-only after init
File: state.rs

pub gpu_init_result: Mutex<GpuInitResult>,
After initialization in lib.rs, gpu_init_result is only ever read. Using Mutex forces exclusive access for reads. Should be RwLock (or even OnceLock/atomic since it's write-once).

3.8 translate_with_deepl takes api_key as a plain String parameter
File: commands.rs

pub async fn translate_with_deepl(
    api_key: String,
    text: String,
    ...
Impact: The API key is passed over Tauri IPC on every call. While IPC is in-process (not network), it means the key is held in multiple string allocations. The key should ideally be stored in backend state (e.g., via a set_api_key command) and referenced from there, or use Tauri's secure storage plugin.

3.9 translate_with_ollama hardcodes localhost:11434
File: commands.rs

let url = "http://localhost:11434/api/chat";
Should be configurable. If Ollama runs on a different port or host, this breaks silently.

3.10 Reqwest Client created per-request in translation commands
Files: commands.rs L1253, commands.rs L1346

let client = reqwest::Client::new();
Impact: Each call creates a new HTTP client with its own connection pool, TLS state, etc. A shared Client in AppState would reuse connections and be more efficient.

3.11 Mask pixel loop uses manual copy instead of image::imageops::crop_imm
File: commands.rs

let mut cropped_mask = GrayImage::new(mask_crop_width, mask_crop_height);
for y in 0..mask_crop_height {
    for x in 0..mask_crop_width {
        let px = (mask_xmin + x).min(mask_width - 1);
        let py = (mask_ymin + y).min(mask_height - 1);
        let pixel = full_mask.get_pixel(px, py);
        cropped_mask.put_pixel(x, y, *pixel);
    }
}
Impact: Per-pixel get_pixel/put_pixel has bounds-checking overhead for every pixel. Could use image::imageops::crop_imm on a DynamicImage::ImageLuma8 wrapper, or use raw buffer slicing.

3.12 erode_mask defined twice — top-level and inside run_inpainting_pipeline
Files: commands.rs line 633 (inside run_inpainting_pipeline as nested fn erode_mask) and commands.rs line 934 (top-level fn erode_mask). Both implementations are identical (invert → dilate → invert). The nested one shadows the top-level one within run_inpainting_pipeline.

LOW
3.13 ocr command appears unused by frontend
The frontend exclusively uses cache_ocr_image + ocr_cached_block. The direct ocr command at line 180 is still registered but has no frontend callers. It's not harmful but is dead surface area.

3.14 inpaint_region (non-cached) appears unused by frontend
Frontend exclusively uses cache_inpainting_data + inpaint_region_cached. The raw inpaint_region at line 862 is registered but uncalled.

3.15 get_gpu_devices has no frontend callers
Registered in invoke_handler but never called.

3.16 mask_dynamic declared as mut unnecessarily
File: commands.rs

let mut mask_dynamic = image::DynamicImage::ImageLuma8(mask_image);
write_to takes &mut self so it does need mut, but the variable is never reassigned — minor.

3.17 Debug triptych pixel copy loop is unoptimized
File: commands.rs — manual per-pixel triptych construction. Performance doesn't matter since it's debug-only, but imageops::overlay would be cleaner.

3.18 render_and_export_image performs no spawn_blocking for text rendering
File: commands.rs Font loading + text rendering is CPU-bound work happening on the async runtime, same class of issue as 3.4 but lower severity since export is user-triggered (infrequent).

4. Summary Table
#	Severity	Issue	Location
3.1	CRITICAL	blocking_lock() in sync command on async runtime	commands.rs#L1117
3.2	HIGH	Sync I/O in get_system_fonts blocks runtime	commands.rs#L401
3.3	HIGH	Sync wgpu enumeration in get_gpu_devices (+ unused)	commands.rs#L1085
3.4	HIGH	ONNX inference not wrapped in spawn_blocking	commands.rs#L128, #L759
3.5	HIGH	Deprecated inpaint fn still has #[tauri::command]	commands.rs#L373
3.6	HIGH	Duplicate RenderRequest + render_and_export_image	commands.rs#L1384 vs render.rs#L10
3.7	MEDIUM	gpu_init_result uses Mutex for read-only data	state.rs#L24
3.8	MEDIUM	API key passed per-call over IPC	commands.rs#L1219
3.9	MEDIUM	Ollama URL hardcoded	commands.rs#L1318
3.10	MEDIUM	Reqwest Client created per-request	commands.rs#L1253, #L1346
3.11	MEDIUM	Manual pixel loop for mask crop	commands.rs#L570
3.12	MEDIUM	erode_mask defined twice (duplicate code)	commands.rs#L633 + #L934
3.13	LOW	ocr command unused by frontend	commands.rs#L180
3.14	LOW	inpaint_region (non-cached) unused by frontend	commands.rs#L862
3.15	LOW	get_gpu_devices unused by frontend	commands.rs#L1085
3.16	LOW	Minor unnecessary mut	commands.rs#L145
3.17	LOW	Debug triptych manual pixel loops	commands.rs#L1033
3.18	LOW	render_and_export_image CPU work on async runtime	commands.rs#L1392
5. Architecture Observations
Positive:

Cache pattern (cache_* → *_cached) is well-designed — avoids re-sending multi-MB images per bbox
Arc<DynamicImage> in caches avoids cloning large buffers
Error handling via anyhow + CommandError wrapper is clean and consistent
OCR fallback mechanism (PaddleOCR → MangaOCR) is robust
Model loading uses spawn_blocking + timeout correctly in initialize()
Detailed tracing with timing throughout
Missing commands the frontend might need:

get_available_ocr_engines — frontend currently can only switch engines but can't discover what's available
batch_ocr — the frontend loops ocr_cached_block sequentially per bbox; a batch command could run them in parallel or pipeline them
get_model_status — check if specific models (PaddleOCR, MangaOCR, LaMa) are loaded, beyond just GPU status
Configurable Ollama endpoint (currently hardcoded)





Comic Text Detector — Technical Analysis
1. Model Architecture
What it detects: Two-headed ONNX model (from mayocream/comic-text-detector-onnx on Hugging Face):

blk output: YOLO-style bounding boxes for text blocks. Two classes (indices 0 and 1 — likely "text bubble" and "free text"). Format per detection: [cx, cy, w, h, confidence, class0_score, class1_score].
seg output: Single-channel segmentation mask (1×1×1024×1024) — pixel-level text mask.
Input: 1×3×1024×1024 RGB tensor, normalized to [0, 1].

2. Pre-processing Pipeline (lib.rs)
Step	Detail
Resize	resize_exact(1024, 1024) with CatmullRom — squashes to square, ignoring aspect ratio
Normalization	/255.0 — simple [0, 1] scaling, no mean/std normalization
Layout	NCHW (batch=1, channels=3, h=1024, w=1024)
Pixel iteration	Per-pixel loop via image.pixels()
3. Post-processing Pipeline (lib.rs)
Step	Detail
BBox extraction	Filters by confidence_threshold, rescales cx/cy/w/h by w_ratio/h_ratio, converts to xmin/ymin/xmax/ymax
NMS	candle_transformers::non_maximum_suppression — per-class NMS
Mask threshold	Pixel values < 30/255 → 0, else keep (line 34)
Morphology	Dilate (3×3 square) → Erode (L2 norm, radius 1) — a closing-like operation to fill small gaps
4. ONNX Session Configuration (lib.rs)
Optimization: Level3 (maximum)
Threads: available_parallelism (all cores)
Execution Provider: default (CPU only — no explicit CUDA/DirectML)
5. Issues Found
CRITICAL — No GPU Execution Provider
Severity: HIGH | lib.rs L41-44

The session builder doesn't register CUDA or DirectML execution providers. Despite the project supporting --features=cuda for the Tauri build, this model always runs on CPU.

// CURRENT
let model = Session::builder()?
    .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
    .with_intra_threads(thread::available_parallelism()?.get())?
    .commit_from_file(model_path)?;
Fix: Add conditional GPU EP registration (matching how ort 2.0-rc.10 works):

pub fn new() -> anyhow::Result<Self> {
    let api = Api::new()?;
    let repo = api.model("mayocream/comic-text-detector-onnx".to_string());
    let model_path = repo.get("comic-text-detector.onnx")?;

    let builder = Session::builder()?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
        .with_intra_threads(thread::available_parallelism()?.get())?;

    // Try CUDA first, fall back to CPU
    #[cfg(feature = "cuda")]
    let builder = builder.with_execution_providers([
        ort::execution_providers::CUDAExecutionProvider::default().build(),
    ])?;

    let model = builder.commit_from_file(model_path)?;
    Ok(ComicTextDetector { model })
}
CRITICAL — Extremely Slow Pixel-by-Pixel Pre-processing
Severity: HIGH | lib.rs L62-69

Iterating image.pixels() calls GenericImageView::pixels() which creates an iterator over every pixel individually. For a 1024×1024 image that's ~1M iterations with individual indexing into a 4D ndarray. This is orders of magnitude slower than a bulk copy.

// CURRENT — ~1M individual index operations
for pixel in image.pixels() {
    let x = pixel.0 as usize;
    let y = pixel.1 as usize;
    let [r, g, b, _] = pixel.2.0;
    input[[0, 0, y, x]] = (r as f32) / 255.0;
    input[[0, 1, y, x]] = (g as f32) / 255.0;
    input[[0, 2, y, x]] = (b as f32) / 255.0;
}
Fix: Use raw bytes with slice operations:

let rgb_image = image.to_rgb8();
let raw = rgb_image.as_raw(); // &[u8], HWC interleaved
let mut input = ndarray::Array::zeros((1, 3, 1024, 1024));
for y in 0..1024 {
    for x in 0..1024 {
        let idx = (y * 1024 + x) * 3;
        input[[0, 0, y, x]] = raw[idx] as f32 / 255.0;
        input[[0, 1, y, x]] = raw[idx + 1] as f32 / 255.0;
        input[[0, 2, y, x]] = raw[idx + 2] as f32 / 255.0;
    }
}
Or even better, use ndarray::Array::from_shape_fn:

let rgb_image = image.to_rgb8();
let raw = rgb_image.as_raw();
let input = ndarray::Array::from_shape_fn((1, 3, 1024, 1024), |(_, c, y, x)| {
    raw[(y * 1024 + x) * 3 + c] as f32 / 255.0
});
MEDIUM — Aspect Ratio Distortion
Severity: MEDIUM | lib.rs L58

resize_exact(1024, 1024) squashes any image to a square. Manga pages are typically tall (3:4 or taller), so text gets horizontally stretched. This likely degrades detection accuracy.

Fix: Pad to square first, then resize:

fn pad_to_square(img: &image::DynamicImage) -> image::DynamicImage {
    let (w, h) = img.dimensions();
    let max_dim = w.max(h);
    let mut padded = image::RgbImage::new(max_dim, max_dim);
    // Fill with white/gray background
    for pixel in padded.pixels_mut() {
        *pixel = image::Rgb([255, 255, 255]);
    }
    image::imageops::overlay(
        &mut padded,
        &img.to_rgb8(),
        ((max_dim - w) / 2) as i64,
        ((max_dim - h) / 2) as i64,
    );
    image::DynamicImage::ImageRgb8(padded)
}
Then adjust w_ratio/h_ratio to account for the padding offset. This depends on whether the original CTD training used letterboxing — check the Python reference implementation to confirm.

MEDIUM — Mask Not Resized to Original Dimensions
Severity: MEDIUM | lib.rs L127-L137

The segmentation mask is returned at 1024×1024 regardless of the original image size. The main.rs CLI (main.rs L50-56) resizes it, but the library inference() does not. The Tauri command layer (commands.rs L149-154) sends the raw 1024×1024 mask to the frontend as PNG, meaning the frontend must handle the resize.

This is a leaky abstraction. The bboxes are rescaled to original coordinates already, but the mask is not.

Fix: Resize the mask inside inference():

let segment = image::imageops::resize(
    &segment, orig_width, orig_height,
    image::imageops::FilterType::CatmullRom,
);
let mask_width = orig_width;
let mask_height = orig_height;
MEDIUM — No Bounding Box Clamping
Severity: MEDIUM | lib.rs L88-L93

After rescaling, xmin/ymin could be negative, and xmax/ymax could exceed the original image dimensions. No clamping is applied.

// CURRENT
xmin: center_x - width / 2.,
ymin: center_y - height / 2.,
xmax: center_x + width / 2.,
ymax: center_y + height / 2.,
Fix:

xmin: (center_x - width / 2.).max(0.0),
ymin: (center_y - height / 2.).max(0.0),
xmax: (center_x + width / 2.).min(orig_width as f32),
ymax: (center_y + height / 2.).min(orig_height as f32),
LOW — &mut self Not Required
Severity: LOW | lib.rs L50

inference takes &mut self but the Session::run method in ort 2.0-rc.10 only needs &self. This forces the Tauri layer to use Mutex for exclusive access, preventing concurrent inferences (which is fine for now but architecturally limiting).

// CURRENT
pub fn inference(&mut self, ...) -> ...
// BETTER (if ort supports it)
pub fn inference(&self, ...) -> ...
Verify with ort 2.0-rc.10 docs — Session::run takes &self, so &mut is unnecessary.

LOW — Hardcoded Model ID
Severity: LOW | lib.rs L38-39

The HF repo "mayocream/comic-text-detector-onnx" and filename "comic-text-detector.onnx" are hardcoded. If the model is updated or a quantized variant is available, nothing can be swapped.

LOW — Morphology Operations May Be Suboptimal
Severity: LOW | lib.rs L121-L126

Dilate then erode with different norms/kernels:

Dilate: 3×3 square, grayscale
Erode: L2 norm, radius 1 (circular)
This mixing of square dilation with circular erosion is unusual. Typically closing uses the same structuring element for both. This could create artifacts at diagonal edges.

LOW — Unnecessary Intermediate Allocation
Severity: LOW | lib.rs L108-L116

let mask = mask.view().to_owned().into_dimensionality::<ndarray::Ix4>()?;
.to_owned() clones the entire 1024×1024 float array (4 MB). Then mapv creates another copy. You could avoid one copy:

let mask = outputs["seg"].try_extract_array::<f32>()?;
let mask = mask.view();
// directly slice and mapv without .to_owned()
let mask_slice = mask.slice(ndarray::s![0, 0, .., ..]);
let thresholded = mask_slice.mapv(|x| { ... });
The .to_owned() + .into_dimensionality() is only needed to go from IxDyn → Ix4, but the subsequent .slice() works on IxDyn too:

let mask_slice = mask.slice(ndarray::s![0, 0, .., ..]);
INFO — No Input Validation
Severity: LOW | lib.rs L50-54

No validation that:

confidence_threshold is in [0, 1]
nms_threshold is in [0, 1]
Image has non-zero dimensions
Not critical since this is internal, but a debug_assert! would catch misuse.

6. Performance Summary
Metric	Value	Notes
Input size	1024×1024 fixed	~3 MB float tensor
Batch size	1	No batching support
Pre-processing	~10-50ms (CPU)	Pixel loop is bottleneck
Inference	~200-2000ms	CPU only, no GPU EP
Post-processing	~5-20ms	NMS + morphology
Peak memory	~50-100 MB	Model weights + tensors + mask copies
GPU support	None	Critical gap
Concurrency	Blocked by &mut self	One inference at a time
7. Overall Assessment
Category	Rating
Correctness	B — Works, but lacks bbox clamping and mask resizing
Performance	C — CPU-only, slow pixel loop, unnecessary allocations
Error handling	B+ — Uses anyhow, propagates errors properly
Code quality	B — Clean and readable, minor issues
GPU utilization	F — None despite project claiming CUDA support
Priority fixes in order:

Add CUDA/DirectML execution providers (biggest perf win)
Replace pixel loop with bulk array construction
Clamp bounding boxes
Resize mask to original dimensions in library
Change &mut self → &self on inference


Koharu Frontend State Management Analysis
1. Store Fields Inventory
Image & Pipeline State
Field	Type	Line	Purpose
image	Image | null	L274	Current loaded manga image (bitmap + ArrayBuffer)
inpaintedImage	Image | null	L287	Result of LaMa inpainting
currentStage	'original' | 'textless' | 'rectangles' | 'final'	L292	Active pipeline preview stage
pipelineStages	Record<string, Image | null>	L293	Cached image for each stage
Detection & OCR
Field	Type	Line	Purpose
textBlocks	TextBlock[]	L276	Detected text bounding boxes + OCR + translation results
selectedBlockIndex	number | null	L289	Currently selected block (by index)
selectedBlockId	string | null	L290	Currently selected block (by ID)
ocrEngine	'manga-ocr' | 'paddle-ocr'	L304	Active OCR engine
availableOcrModels	string[]	L303	Hardcoded list of OCR engines
Segmentation
Field	Type	Line	Purpose
segmentationMask	Uint8Array | null	L281	Raw mask data
segmentationMaskWidth	number | null	L282	Mask dimensions
segmentationMaskHeight	number | null	L283	Mask dimensions
segmentationMaskBitmap	ImageBitmap | null	L284	Rendered mask for canvas overlay
showSegmentationMask	boolean	L285	Toggle mask visibility
UI / Tools
Field	Type	Line	Purpose
tool	string	L275	Active tool (detection, ocr, render, etc.)
scale	number	L276	Canvas zoom level
theme	'light' | 'dark'	L288	App theme
sidebarWidth	number	L307	Sidebar pixel width
lastExpandedSidebarWidth	number	L308	Remembered width for expand toggle
isSidebarCollapsed	boolean	L309	Sidebar collapsed state
selectionSensitivity	number	L306	Hit target sizing (10-40px)
addTextAreaHandler	(() => void) | null	L311	Callback bridge: canvas → detection-controls
Rendering
Field	Type	Line	Purpose
renderMethod	'rectangle' | 'lama' | 'newlama'	L288	Text rendering strategy
defaultFont	string	L301	Default font for rendered text
fontSizeStep	number	L302	Increment for bulk font-size adjust
inpaintingConfig	InpaintingConfig	L299	Full inpainting parameter set
inpaintingPreset	'fast' | 'balanced' | 'quality' | 'custom'	L300	Active preset name
Translation / API
Field	Type	Line	Purpose
translationApiKey	string | null	L278	Google Translate key
deeplApiKey	string | null	L279	DeepL key
ollamaModel	string	L280	Ollama model name
ollamaSystemPrompt	string	L280	Custom system prompt
translationProvider	'google' | 'deepl-free' | 'deepl-pro' | 'ollama'	L281	Active provider
Performance / Debug
Field	Type	Line	Purpose
gpuPreference	'cuda' | 'directml' | 'cpu'	L291	GPU backend
zoomOptimizationsEnabled	boolean	L309	Perf optimizations toggle
zoomMetricsEnabled	boolean	L310	Perf metrics collection
2. Actions/Setters Summary
Action	Line	Behavior
setImage	L354	Sets image and resets all derived state (textBlocks, masks, stages). Properly closes old segmentation bitmap.
setTool	L383	Simple setter
setScale	L384	Simple setter
setTextBlocks	L385	Replaces entire array
updateTextBlock	L387	Updates single block by ID or index with updater function. Creates new array via .slice().
setTranslationApiKey	L406	Sets + persists to localStorage
setDeeplApiKey	L415	Sets + persists to localStorage
setTranslationProvider	L425	Sets + persists to localStorage
setOllamaModel	L431	Sets + persists to localStorage
setOllamaSystemPrompt	L437	Sets + persists to localStorage
setSegmentationMask	L443	Sets raw mask data + dimensions
setSegmentationMaskBitmap	L451	Sets bitmap, closes old one if different
setShowSegmentationMask	L462	Simple setter
setInpaintedImage	L463	Simple setter
setTheme	L464	Sets + persists + toggles CSS class
setRenderMethod	L471	Sets + persists
setSelectedBlockIndex	L477	Simple setter
setSelectedBlockId	L478	Simple setter
setGpuPreference	L479	Sets + persists
setOcrEngine	L485	Sets + persists
setCurrentStage	L491	Simple setter
setPipelineStage	L492	Merges one stage into pipelineStages
setInpaintingPreset	L496	Sets config from preset + marks preset name
setInpaintingConfig	L500	Partial update, clamps maskThreshold, marks preset as 'custom'
setDefaultFont	L513	Sets + persists
setFontSizeStep	L521	Simple setter
setSelectionSensitivity	L522	Clamped 10-40 + persists
setSidebarWidth	L528	Sets + persists compound sidebar state
setLastExpandedSidebarWidth	L539	Sets + persists
setIsSidebarCollapsed	L550	Sets + persists
setZoomOptimizations	L561	Sets + persists
setZoomMetrics	L567	Sets + persists
setAddTextAreaHandler	L576	Simple setter

3. Data Flow Patterns
Image load → setImage() → resets ALL derived state
  ↓
Detection → setTextBlocks() + setSegmentationMask() + setSegmentationMaskBitmap()
  ↓
OCR → setTextBlocks() (updates .text on each block)
  ↓
Translation → setTextBlocks() (updates .translatedText on each block)
  ↓
Inpainting → setInpaintedImage() + setPipelineStage('textless', ...)
  ↓
Rendering → setPipelineStage('withRectangles' | 'final', ...)
  ↓
Stage switching → setCurrentStage() → canvas reads pipelineStages[stage]
Cross-component communication:

addTextAreaHandler: canvas registers a handler → detection-controls invokes it (function-in-state pattern)
selectedBlockIndex / selectedBlockId: canvas ↔ sidebar panels sync selected block
Persistence: ~15 settings are mirrored to localStorage with paired load/set functions.

4. Issues Found
CRITICAL — currentStage / pipelineStages key mismatch
Severity: HIGH

L333: currentStage accepts 'rectangles' but L339: pipelineStages uses key withRectangles. The topbar has to manually map 'rectangles' → 'withRectangles'. This is a naming inconsistency that's fragile and confusing. If any code path does pipelineStages[currentStage] directly with 'rectangles', it will silently return undefined.

CRITICAL — image / inpaintedImage / pipelineStages bitmaps never closed
Severity: HIGH

setImage() correctly closes segmentationMaskBitmap at L356-360, but it never calls .close() on:

The old image.bitmap
The old inpaintedImage.bitmap
Any pipelineStages.*.bitmap (up to 4 ImageBitmap objects)
Each ImageBitmap holds GPU texture memory. Loading multiple images in a session will leak all of these. This is a real memory leak.

HIGH — Dual selection mechanism (selectedBlockIndex + selectedBlockId)
Severity: MEDIUM-HIGH

Both fields exist independently with separate setters (L477-478). There is no synchronization — callers must remember to set both. detection-panel.tsx sets both (L132-133), but ocr-panel.tsx only sets selectedBlockIndex (L227). This creates inconsistent selection state. Should be unified into a single action or a single field.

HIGH — tool typed as string instead of a union
Severity: MEDIUM

L275: tool: string — this loses all type safety. It should be:

tool: 'detection' | 'ocr' | 'translation' | 'inpaint' | 'render' | 'export'
Any typo in setTool('detectoin') will silently work but break the UI.

MEDIUM — availableOcrModels is a hardcoded constant stored as mutable state
Severity: LOW-MEDIUM

L303: availableOcrModels: ['manga-ocr', 'paddle-ocr'] — this never changes, has no setter, and is never consumed by any component. It's dead weight in the store. Should be a plain export constant or removed.

MEDIUM — Segmentation mask stored as 3 separate nullable fields
Severity: MEDIUM

L281-283: segmentationMask, segmentationMaskWidth, segmentationMaskHeight are always set/cleared together (see setSegmentationMask at L443). This should be a single SegmentationMaskInfo | null field to prevent impossible states where mask is set but width is null.

MEDIUM — No loading/error state in the global store
Severity: MEDIUM

There is zero loading or error state. Every async operation (detection, OCR, translation, inpainting) must manage its own loading state via useState in individual components, which means:

No global progress indicator
Can't prevent conflicting concurrent operations (e.g., starting OCR while detection is running)
No centralized error reporting
MEDIUM — setInpaintedImage doesn't close old bitmap
Severity: MEDIUM

L463 is set({ inpaintedImage: image }) — if called twice (e.g., re-inpainting), the previous ImageBitmap leaks.

MEDIUM — Sidebar persistence calls persistSidebarState on every pixel during resize
Severity: LOW-MEDIUM

L528-548: setSidebarWidth writes to localStorage (synchronous disk I/O) on every width change. During drag resize, this could fire hundreds of times per second. Should debounce.

LOW — TextBlock.id is optional
Severity: LOW

L101: id?: string — but updateTextBlock and selectedBlockId depend on IDs. If detection doesn't assign IDs, the ID-based lookup path fails silently (L393-394).

LOW — Type assertion on initial state instead of typed object
Severity: LOW

L312-353: The initial state is written as an untyped object literal and then cast via as { ... }. This means the initial values aren't checked against the type asserted — e.g., tool: 'detection' is asserted as string, hiding the missing union type.

5. Redundant / Unused Fields
Field	Status	Evidence
availableOcrModels	UNUSED	No component reads it. Only defined at L303 and typed at L334.
gpuPreference	Used only in settings	Read in settings-dialog.tsx and gpu-status-panel.tsx, but no Tauri command actually uses it from state (it's passed as a separate parameter). Verify if the backend reads from state or from invoke params.
6. Missing State Fields
Missing Field	Why Needed
isProcessing / per-stage loading flags	Prevent concurrent operations, show spinners
error / lastError	Centralized error display
undoHistory / redoHistory	No undo support for block edits
isDirty	Track unsaved changes before closing
sourceLanguage / targetLanguage	Hardcoded to JP→EN assumption
7. Race Conditions & Stale State
Concurrent setTextBlocks calls: OCR and translation both call setTextBlocks() with the full array. If OCR is running and the user starts translation simultaneously, the slower operation will overwrite results from the faster one. No locking mechanism exists.

updateTextBlock uses .findIndex: At L393, the lookup by ID happens at call time. If textBlocks was replaced between the user action and the state update (another setTextBlocks call), the index could be stale. Zustand's set(state => ...) callback pattern protects against this, so the .findIndex runs on current state — this is correctly implemented.

addTextAreaHandler function reference: Stored in state, but if the canvas re-renders and creates a new handleAddTextArea closure, the old reference in state is stale until useEffect runs. Brief window of staleness exists.

8. Memory Management
Resource	Cleanup	Verdict
segmentationMaskBitmap	.close() in setImage and setSegmentationMaskBitmap	GOOD
image.bitmap	Never closed	LEAK
inpaintedImage.bitmap	Never closed	LEAK
pipelineStages.*.bitmap (×4)	Never closed	LEAK
segmentationMask (Uint8Array)	Set to null on reset	OK (GC handles it)
image.buffer (ArrayBuffer, potentially MB+)	Set to null on reset	OK (GC handles it)
Impact: Loading a 4000×6000px manga page creates an ImageBitmap 92MB in GPU memory. Running the full pipeline creates up to 6 more. Switching images leaks all of them. After processing ~10 images, this could consume **1GB of GPU texture memory**.

9. Type Safety
tool: string — L275 — should be a union type. UNSAFE
as { ... } cast — L312 — circumvents type checking on initial values. UNSAFE
TextBlock uses many optional fields — 20+ optional fields increase the surface for runtime undefined access. Consider splitting into base DetectedBlock and augmented ProcessedBlock.
All exported interfaces are properly typed — InpaintingConfig, RGB, SegmentationMaskInfo, AppearanceMetadata are well-defined.
No any types — the codebase is free of explicit any. GOOD
10. Performance / Re-renders
Massive selector calls: Many components destructure 5-15 fields from useEditorStore() at once (e.g., canvas.tsx L38-48 pulls ~15 fields). Every state change to any of those fields triggers a re-render. This means changing scale re-renders canvas (expected), but changing theme also re-renders canvas (wasteful).

Fix: Use individual selectors:

const scale = useEditorStore(s => s.scale)
const tool = useEditorStore(s => s.tool)
Or use useShallow from Zustand.

setTextBlocks replaces the entire array: Every OCR result or translation update replaces the full textBlocks array, forcing every component that reads textBlocks to re-render, even if only one block changed. updateTextBlock correctly creates a new array, but downstream components have no way to know only index 3 changed.

No memoization of derived data: pipelineStages[currentStage] is recomputed on every render in background-layer.tsx L20. Consider a Zustand selector.

Summary: Priority Fixes
Priority	Issue	Effort
P0	Close old ImageBitmaps in setImage, setInpaintedImage, setPipelineStage	Small
P0	Unify currentStage/pipelineStages key naming (rectangles vs withRectangles)	Small
P1	Type tool as a proper union	Small
P1	Merge selectedBlockIndex + selectedBlockId into one action	Small
P1	Consolidate segmentation mask into a single nullable object	Medium
P2	Add selectors / useShallow to prevent unnecessary re-renders	Medium
P2	Add global isProcessing / error state	Medium
P2	Debounce sidebar persistence during drag	Small
P3	Remove availableOcrModels from store	Trivial
P3	Use a proper typed initial state instead of as cast	Small


Koharu Canvas & Rendering System — Comprehensive Analysis
1. Architecture Overview
The canvas is Konva.js-based (via react-konva), with a hybrid rendering approach: Konva <Stage> handles image/detection layers while a raw HTML overlay (HtmlRenderLayer) handles text rendering. The main orchestration lives in canvas.tsx.

Layer Stack (bottom to top):
Layer	Component	Renders
1	BackgroundLayer	Base image (original / textless / rectangles / final)
1.5	(conditional)	Segmentation mask overlay at 60% opacity
2	InpaintLayer	Inpainted image (when in inpaint mode)
3	RenderLayer	Rectangle fills with background color (Konva <Rect>)
4	DetectionLayer	Bounding boxes, transformer handles, numbered labels
5	HtmlRenderLayer	HTML DOM overlay for final text rendering (not Konva!)
2. Detailed Findings
2.1 Zoom/Pan System
How it works: Wheel events are captured natively (canvas.tsx), pointer-anchored zoom is computed, and updates are batched via requestAnimationFrame when zoomOptimizationsEnabled is true.

Strengths:

rAF batching prevents redundant Konva redraws (L310-L326)
Scale quantization to 0.01 increments prevents floating-point jitter (L280)
Transformer redraws are debounced during zoom (detection-layer.tsx)
Dedicated perf monitor (zoom-performance.ts) with P95 frame time tracking
Issues:

Severity	Issue	Location
Medium	handleWheel callback has a stale closure over setScale — it reads stage.scaleX() directly but the rAF path calls setScale() which triggers a React state update. Between rAF batching and React reconciliation, there's a 1-frame lag where Konva's internal scale and React state diverge.	canvas.tsx L270-L330
Medium	clampStagePosition depends on scale from React state, but during rapid wheel zoom the pending rAF hasn't flushed yet. The clamping uses stale scale values.	canvas.tsx L175-L191
Low	Zoom range is clamped to [0.1, 2.0] — for high-DPI manga images (4000+ px), max zoom of 2x may not be enough for detail inspection.	canvas.tsx L215
Low	wheelTimeoutRef (300ms debounce) means "zooming" state persists 300ms after last wheel event, during which transformer redraws are throttled. On trackpads with momentum scrolling, this could cause stale transformer positions.	canvas.tsx L338-L348
2.2 Text Block Visualization (Detection Mode)
How it works: DetectionBlock (detection-block.tsx) renders each block as a Konva <Group> with:

A near-invisible fill <Rect> (opacity 0.001) for hit testing
A colored stroke <Rect> (red = unselected, blue = selected, orange = OCR stale)
A numbered <Circle> + <Text> label at the top-left corner
<Transformer> for resize handles
Strengths:

React.memo on DetectionBlock prevents unnecessary re-renders
Screen-space-aware sizing (anchor, stroke width scale with zoom via screenSpace useMemo)
strokeScaleEnabled={false} keeps stroke width consistent regardless of zoom
Issues:

Severity	Issue	Location
High	DetectionBlock reads from useEditorStore() directly inside a React.memo component — Zustand selectors are not granular here. Each call to updateTextBlock, setSelectedBlockIndex, or setSelectedBlockId triggers all DetectionBlock instances to re-evaluate store subscriptions. With 50+ text blocks, this causes O(n) subscription checks per interaction.	detection-block.tsx L44-L49
Medium	The transformer attachment in DetectionLayer uses stage.findOne(.region-${activeSelectionKey}) which performs a DOM-like tree walk on every selection change. For large block counts, this is slow.	detection-layer.tsx L57-L65
Medium	handlePointerDown in DetectionBlock calls startDrag() imperatively. This is a known Konva anti-pattern that can cause drag state inconsistencies, especially in combination with the transformer.	detection-block.tsx L88-L108
Low	Block label <Circle> is positioned at negative offset (-labelOffset, -labelOffset) — for blocks near the top-left image edge (xmin≈0, ymin≈0), the label renders outside the canvas and is clipped.	detection-block.tsx L137-L144
2.3 HTML Render Layer (Text Overlay)
How it works: html-render-layer.tsx renders an absolutely-positioned <div> that mirrors Konva's transform (translate + scale) via CSS. Inside it, each text block is rendered as a <SmartFitText> component with CSS-based text shadow for outlines.

Strengths:

pointerEvents: 'none' lets clicks pass through to the canvas
willChange: 'transform' promotes to GPU compositor layer
Smart writing mode detection (writing-mode.ts) auto-selects vertical-rl for CJK in tall bubbles
Diamond-shaped text shaping via CSS shape-outside (diamond-wrapper.tsx) for speech bubble corners
Issues:

Severity	Issue	Location
Critical	Preview/export rendering mismatch: The live preview uses HtmlRenderLayer (CSS text-shadow outlines, SmartFitText binary-search font sizing, DiamondWrapper shaping), but export uses renderTextWithKonva() (konva-text-render.ts) which is a completely different renderer — no diamond shaping, no CSS text-shadow, different font sizing logic. Exported images will NOT match the preview.	html-render-layer.tsx vs konva-text-render.ts
High	SmartFitText performs a synchronous binary search on DOM layout inside useLayoutEffect (smart-fit-text.tsx L56-L108). For each font size candidate, it sets container.style.fontSize and reads scrollHeight/scrollWidth. With 6 iterations × N blocks, this causes 6N forced reflows on every text/size change.	smart-fit-text.tsx L56-L108
High	The container style recalculates on every stageScale/stagePos change (html-render-layer.tsx L17-L27). While useMemo prevents object identity churn, the transform string changes on every zoom frame, causing React to update the DOM element's inline style — triggering a composite layer update for the entire overlay.	html-render-layer.tsx L17-L27
Medium	mixBlendMode: 'multiply' on each text block (html-render-layer.tsx L82) forces each block into its own compositor layer. With 30+ blocks, this creates 30+ GPU texture uploads.	html-render-layer.tsx L82
Medium	8-point CSS text-shadow for outlines is computationally expensive at large font sizes. Each shadow is a full text paint pass. With 30 blocks, that's 240 shadow paints per frame.	html-render-layer.tsx L64-L73
Low	Outline color/width defaults to white/3px when hasOutline is false (html-render-layer.tsx L57-L58), meaning all text blocks always get an outline, even when none was detected. This changes the visual appearance unintentionally.	html-render-layer.tsx L55-L58
2.4 Font Sizing System
There are three independent font sizing implementations — a code smell:

Module	Used By	Algorithm
font-sizing.ts	Unknown (possibly dead code)	Binary search with canvas measurement
improved-font-sizing.ts	Render panels	Layout-aware penalty-based binary search with caching
smart-fit-text.tsx	HtmlRenderLayer	DOM-based binary search via useLayoutEffect
Issues:

Severity	Issue	Location
High	Three competing font sizing systems create inconsistency. SmartFitText (DOM-based) diverges from improved-font-sizing.ts (canvas-measurement-based) because they use fundamentally different measurement backends. The preview font size won't match the computed block.fontSize.	Multiple files
Medium	font-sizing.ts creates a new <canvas> element per measureText() call (L124-L127). No caching, no reuse. This is called O(log n × words) times during binary search.	font-sizing.ts L124-L127
Medium	improved-font-sizing.ts has a measurement cache limited to 2000 entries with a nuclear clear (L305-L307) — when the cache fills, ALL entries are evicted instead of LRU eviction. This causes periodic perf spikes.	improved-font-sizing.ts L305-L307
Low	improved-font-sizing.ts estimateInitialFontSize uses maskStats?.area but this is in mask space (1024×1024), not image space. The area is used in a formula with boxArea (image space), mixing coordinate systems.	improved-font-sizing.ts L105-L106
2.5 Color Extraction & Appearance Analysis
How it works:

color-extraction.ts samples border pixels around bboxes, uses median for robustness, computes confidence from variance.
appearance-analysis.ts uses the segmentation mask to separate text core / background / outline shell via morphological ops, then samples colors from each region using k-means clustering.
Strengths:

WeakMap cache on ImageBitmap avoids re-drawing image to canvas (color-extraction.ts L21)
K-means++ initialization for better color clustering
PCA-based mask geometry analysis for orientation/eccentricity
Issues:

Severity	Issue	Location
High	processMaskRegions computes Math.sqrt(mask.length) to get width (appearance-analysis.ts L122), assuming the mask is square. But extractLocalMask produces masks with maskWidth × maskHeight dimensions (arbitrary aspect ratio). This corrupts all morphological operations, leading to incorrect text/outline/background region detection.	appearance-analysis.ts L122
High	Morphological dilate/erode are O(n × r²) where n = mask pixels, r = radius. For a 200×300 block mapped to mask space, with radius=3, this is ~1.08M ops per operation, run twice (dilate + erode). For 30 blocks, that's ~64M ops. No Web Worker offloading.	appearance-analysis.ts L138-L180
Medium	samplePixels creates a new OffscreenCanvas per block (appearance-analysis.ts L250). For 30 blocks, that's 30 canvas allocations + 30 drawImage calls + 30 getImageData calls. No pooling.	appearance-analysis.ts L250
Low	k-means uses Math.random() for initialization (appearance-analysis.ts L407), making results non-deterministic. Same image + block can yield slightly different colors across runs.	appearance-analysis.ts L407
2.6 Alpha Compositing (Inpainting Blend)
How it works: alpha-compositing.ts blends inpainted regions into the base image using:

Mask-guided feathered alpha blending (cosine-smoothed edges)
Optional gradient-domain blending when edge variance is high
Strengths:

Mask region cache via WeakMap prevents redundant extractions
Automatic seam detection + fallback to gradient blending
Cosine-smoothed feather for natural transitions
Issues:

Severity	Issue	Location
High	computeDistanceToEdge is called for every masked pixel inside compositeWithGradientBlend. It performs a brute-force radius search (up to r=10, so 441 pixels checked). For a 300×300 region with ~50% masked, that's ~20M pixel lookups. This should use a distance transform instead.	alpha-compositing.ts L312-L335
Medium	detectHighEdgeVariance creates a temp OffscreenCanvas and draws the inpaint crop to get pixel data, but the caller (compositeMaskedRegion) already has the crop as ImageBitmap. Two redundant canvas draws per block when seam detection is enabled.	alpha-compositing.ts L208-L216
2.7 Image Rendering Pipeline
The BackgroundLayer (background-layer.tsx) selects which image to display based on the active tool and currentStage:

original ─┬─ detection mode → original image
           ├─ render/inpaint mode:
           │   ├─ stage='final'      → pipelineStages.final
           │   ├─ stage='rectangles' → pipelineStages.withRectangles
           │   ├─ stage='textless'   → pipelineStages.textless
           │   └─ default            → original
           └─ other modes           → original
Issues:

Severity	Issue	Location
Medium	<KonvaImage image={baseImage} /> receives null when no image is loaded, but Konva's Image component will throw a warning when image is null. Should render conditionally.	background-layer.tsx L37
Medium	InpaintLayer checks tool === 'inpaint' but BackgroundLayer also renders an image in inpaint mode. When both layers are visible, the inpainted image is drawn on top of the background, but at full opacity — so the background layer's image draw is wasted.	inpaint-layer.tsx L6-L10 + background-layer.tsx L19-L22
2.8 Memory Management
Severity	Issue	Location
High	setImage releases segmentationMaskBitmap via .close() (state.ts L378-L383), but pipeline stage images are not released. Each Image holds an ImageBitmap. Loading a new image orphans up to 4 ImageBitmaps (original, textless, withRectangles, final) which are only GC'd when the WeakRef cycle runs — could hold ~100MB+ for high-res manga.	state.ts L378-L395
Medium	konva-text-render.ts creates a temporary Konva Stage + DOM container for export. If renderTextWithKonva throws between container creation and cleanup, the container stays orphaned in document.body. The finally block exists but only destroys stage — if stage.destroy() throws, removeChild is skipped.	konva-text-render.ts L56-L142
Medium	measurementCache in improved-font-sizing.ts is a module-level Map that persists for the app lifetime. After processing many images, it accumulates stale entries. The nuclear clear at 2000 entries is the only eviction.	improved-font-sizing.ts L27-L28
2.9 Konva Text Export Renderer
konva-text-render.ts creates an offscreen Konva Stage for exporting text to canvas.

Issues:

Severity	Issue	Location
Critical	Uses requestAnimationFrame to "wait for fonts" (L125-L128). This is not a font loading guarantee — rAF fires on next paint, not when fonts finish loading. If a custom font hasn't loaded yet, text renders in fallback font. Should use document.fonts.ready promise.	konva-text-render.ts L125-L128
High	stage.toCanvas() may return a Promise in newer Konva versions. The code handles this (L132), but this indicates fragile API compatibility.	konva-text-render.ts L130-L133
3. Summary of Severity Ratings
Severity	Count	Key Issues
Critical	2	Preview/export rendering mismatch; font loading race in export
High	7	Square mask assumption corrupts appearance analysis; O(n²) distance transform; pipeline ImageBitmap leaks; 3 competing font sizers; DetectionBlock over-subscription; SmartFitText forced reflows; brute-force computeDistanceToEdge
Medium	10	Stale zoom closure; canvas allocation waste; blend mode layer explosion; redundant background draw; etc.
Low	5	Label clipping at edges; hard-coded outline defaults; non-deterministic k-means; etc.
4. Top Concrete Improvement Recommendations
Priority 1: Fix Preview/Export Consistency
The HtmlRenderLayer preview must match the export. Either:

Option A: Export using the same HTML/CSS renderer (html2canvas or Puppeteer-like capture)
Option B: Make the preview use the same Konva text renderer as export
Option C: Share a unified font sizing + layout computation between both paths
Priority 2: Fix processMaskRegions Square Assumption
// appearance-analysis.ts L122 — BUG
const width = Math.sqrt(mask.length) // WRONG: assumes square
// FIX: Pass width/height as parameters to processMaskRegions
Priority 3: Release Pipeline ImageBitmaps
// In setImage, add:
for (const key of ['original', 'textless', 'withRectangles', 'final'] as const) {
  state.pipelineStages[key]?.bitmap?.close?.()
}
Priority 4: Replace Brute-Force Distance Transform
Replace computeDistanceToEdge with a proper Euclidean Distance Transform (EDT) computed once per mask, reducing gradient blending from O(n × r²) to O(n).

Priority 5: Consolidate Font Sizing
Eliminate font-sizing.ts (likely dead code). Make SmartFitText read block.fontSize from improved-font-sizing.ts instead of running its own binary search, or use one as the single source of truth.

Priority 6: Reduce DetectionBlock Re-renders
Use granular Zustand selectors:

const updateTextBlock = useEditorStore(s => s.updateTextBlock)
const setSelectedBlockIndex = useEditorStore(s => s.setSelectedBlockIndex)
Instead of destructuring all store fields.

Priority 7: Defer HtmlRenderLayer During Zoom
Skip re-rendering text blocks while isZooming is true — just update the container transform. Re-render text only after zoom settles (the 300ms timeout already exists).

Koharu Manga Translation App — Comprehensive UX Analysis
1. Overall App Architecture & Pipeline Flow
Layout (page.tsx)
The app uses a three-column layout: Tools sidebar (left, 80px) → Canvas (center, flexible) → Panels sidebar (right, resizable). The sidebar is collapsible with Ctrl+B and supports drag-to-resize with touch-friendly hit targets.

Pipeline mapping to tools
The tool bar (tools.tsx) defines 5 tools in order:

detection (MessageCircle icon) → shows DetectionPanel + OCRPanel
segmentation (SquareDashedMousePointer) → shows NOTHING (no panel mapped)
inpaint (PaintbrushVertical) → shows InpaintSettings + InpaintPanel
translation (Languages) → shows TranslationPanel
render (Type) → shows RenderPanel
Critical Flow Issues:

Issue	Severity	Location
Tool order doesn't match pipeline	High	tools.tsx#L22-L42 — The intended flow is Detection→OCR→Translation→Inpaint→Render, but the toolbar puts inpaint before translation
"Segmentation" tool is a dead end	High	page.tsx#L248-L262 — No panel is rendered when selectedTool === 'segmentation', so clicking it shows an empty sidebar
OCR is hidden inside Detection	Medium	page.tsx#L249-L253 — Users must be on the "detection" tool to see OCR. No dedicated OCR tool step
Pipeline stage viewer only visible on render/inpaint tools	Medium	topbar.tsx#L81-L109 — Can't preview stages while on other tools
2. Panel-by-Panel Analysis
2.1 Detection Panel (detection-panel.tsx)
Purpose: Run text detection on loaded manga image, producing bounding boxes and a segmentation mask.

State reads: image, textBlocks, segmentationMaskBitmap, showSegmentationMask, selectionSensitivity
State writes: setTextBlocks, setSegmentationMask, setSegmentationMaskBitmap, setShowSegmentationMask, setSelectedBlockIndex, setSelectedBlockId
Backend call: invoke('detection', { image, confidenceThreshold, nmsThreshold })

Strengths:

Clean loading state with Radix Button loading={loading}
Stores segmentation mask for downstream inpainting
Auto-runs appearance analysis after detection
Shows block count feedback
UX Issues:

Issue	Line	Severity
No user feedback on error — errors are only console.error'd, never shown in UI	L113-L114	High
No "image required" feedback — console.warn only, button doesn't look disabled when no image loaded	L58-L61	Medium
Detection button has no label — just a Play icon with no tooltip text besides the icon	L125	Low
Sliders lack aria-labels — Radix Slider has no aria-label for screen readers	L136-L142	Medium
"Show detection mask" button isn't a proper toggle — uses Button instead of Switch component for a boolean toggle	L162-L169	Low
2.2 Detection Controls (detection-controls.tsx)
Purpose: Add/delete text area bounding boxes. Shown in the topbar when detection tool is active.

State reads: textBlocks, selectedBlockIndex, addTextAreaHandler
State writes: setTextBlocks, setSelectedBlockIndex, setSelectedBlockId

Strengths:

Good disabled states (delete disabled when nothing selected, add disabled when no handler)
Shows selected block number
UX Issues:

Issue	Line	Severity
No undo support — deleting a block is irreversible	L28-L33	Medium
Delete without confirmation — one click deletes immediately	L28	Low
2.3 OCR Panel (ocr-panel.tsx)
Purpose: Run OCR on detected text blocks to extract Japanese text. Supports inline editing of OCR results.

State reads: image, textBlocks
State writes: setTextBlocks, setSelectedBlockIndex
Backend calls: invoke('cache_ocr_image'), invoke('ocr_cached_block'), invoke('clear_ocr_cache')

Strengths:

Auto-OCR on stale boxes — when boxes are moved, auto-triggers OCR with 1500ms debounce (L152-L168)
Manual edit support — click-to-edit with autosave on 400ms timeout
Stale/manual edit badges — visual indicators for box state (orange = stale, blue = manual edit)
Good accessibility on text blocks — role='textbox', tabIndex={0}, keyboard Enter/Space handlers (L305-L315)
Unmount persistence — saves in-progress edits if component unmounts (L184-L190)
UX Issues:

Issue	Line	Severity
Error only logged to console — console.error('Error during OCR:', error) with no UI feedback	L131	High
No loading progress — blocks are processed sequentially but there's no per-block progress indicator	L91-L121	Medium
max-h-[600px] hard limit — panel height is capped regardless of available screen space	L197	Low
persistManualEdit closure bug — the useCallback has textBlocks in its dependency array, which means it captures stale references; the sourceBlocks parameter mitigates this but only for unmount	L30-L46	Medium
2.4 Translation Panel (translation-panel.tsx)
Purpose: Translate OCR'd Japanese text to English using Google Cloud, DeepL, or Ollama.

State reads: textBlocks, translationApiKey, deeplApiKey, ollamaModel, ollamaSystemPrompt, translationProvider
State writes: setTextBlocks
Backend calls: None directly — uses translate() utility which calls external APIs via fetch

Strengths:

Excellent error handling — specific messages for 401/403/429 errors, clear "API key not set" guidance (L39-L88)
Progress tracking — "Translating block 3/12..." (L65)
Rate limit protection — 100ms delay between blocks (L83)
Inline translation editing — click-to-edit with autosave
Success/error callouts — visual feedback for all outcomes
Disabled state when no API key — button properly disabled with canTranslate check (L144)
UX Issues:

Issue	Line	Severity
Translation edits not debounced safely — autosaveTimeout references textBlocks from closure, can save stale state	L99-L109	Medium
Can't translate individual blocks — all-or-nothing, no per-block translate button	L57-L85	Low
max-h-[800px] hard limit — different from OCR's 600px, inconsistent	L147	Low
No "skip translated" option — re-runs translation on all blocks even if some are already translated	L57	Medium
Progress message disappears on subsequent visits — progress state resets on re-mount	L22	Low
2.5 Inpaint Panel (inpaint-panel.tsx)
Purpose: Remove Japanese text from manga using LaMa AI inpainting.

State reads: image, segmentationMask, segmentationMaskWidth/Height, textBlocks, renderMethod, inpaintingConfig
State writes: setInpaintedImage, setPipelineStage, setCurrentStage
Backend calls: invoke('cache_inpainting_data'), invoke('inpaint_region_cached'), invoke('clear_inpainting_cache')

Strengths:

Cancel support — cancel button during processing (L454)
Progress bar — per-block progress with Radix Progress component (L449-L458)
Status checklist — clear prerequisite indicators (Image ✓, Mask ✓, etc.) (L391-L414)
Smart mode detection — disables when rectangle mode is selected with informative callout
Cache cleanup — always clears cache in finally block (L206-L211)
UX Issues:

Issue	Line	Severity
Massive code duplication — runLocalizedInpainting and runNewLamaInpainting are ~90% identical (each ~100 lines), only differing in the compositing call	L83-L213 vs L215-L357	High (code quality)
"Rectangle fill" error message is misleading — says "Inpainting is not needed" but user clicked inpaint, should guide to render instead	L52-L53	Medium
Cancel doesn't actually abort in-flight invoke — sets a flag that's checked between blocks, but current block still completes	L41	Low
Instructions mention "Rectangle mode: Instant, uses full image inpainting" — contradicts the blue callout above saying rectangle doesn't need AI	L468-L474	Medium
2.6 Inpaint Settings (inpaint-settings.tsx)
Purpose: Configure inpainting quality presets and advanced parameters.

State reads: inpaintingConfig, inpaintingPreset
State writes: setInpaintingPreset, setInpaintingConfig

Strengths:

Three-tier presets (Fast/Balanced/Quality) with clear descriptions and time estimates
Progressive disclosure — advanced settings hidden behind toggle, expert options behind <details>
Live config display — current values shown next to sliders
Custom badge — shows "Custom" badge when settings differ from presets
UX Issues:

Issue	Line	Severity
"Target Resolution" note is confusing — comment says "removed" but targetSize is still in the config and sent to backend	L93	Low
No visual preview of mask changes — adjusting erosion/dilation/threshold has no preview	N/A	Medium
Advanced toggle uses raw HTML <button> — inconsistent with Radix UI elsewhere	L85-L90	Low
2.7 Render Panel (render-panel.tsx)
Purpose: Process colors/fonts for translated text, generate final composition, and export.

State reads: image, textBlocks, renderMethod, inpaintedImage, pipelineStages, defaultFont
State writes: setTextBlocks, setRenderMethod, setPipelineStage, setCurrentStage, setTool
Backend calls: invoke('get_current_gpu_status'), invoke('render_and_export_image') (for export)

Strengths:

Dual actions — "Process" (calculate colors) and "Export" (save image) as separate buttons
Per-block customization — expandable block list with RenderCustomization component
Step-by-step instructions when no translations exist (L729-L741)
Smart color extraction — always uses original image, never inpainted (L116-L120)
Three render methods with descriptive Select options
UX Issues:

Issue	Line	Severity
Syntax error in import — line 8 has garbage: // Step 2: Get the correct base image} from '@/lib/state' — there's a comment fragment mixed into the import	L8	Critical
Duplicate import — both useEditorStore from '../lib/state' (L7) and from '@/lib/state' (L8)	L7-L8	Critical
~200 lines of commented-out debug code — massive debug blocks wrapped in /* */ throughout export function	L220-L290	Medium (code quality)
Export doesn't show loading state — no processing indicator during export	L300	Medium
Render method selector is in Render panel but affects Inpaint panel — confusing ownership	L686-L714	Medium
GPU status fetched twice — once in render-panel, once embedded in settings-dialog	L73-L77	Low
2.8 Render Customization (render-customization.tsx)
Purpose: Per-block customization of colors, fonts, sizing, weight, and stretch.

State reads: textBlocks
State writes: setTextBlocks
Backend calls: invoke('get_system_fonts')

Strengths:

Live font preview — shows sample text in selected font/size/weight/spacing
Reset buttons — for manual color overrides
Confidence badge — shows appearance analysis confidence level
System font loading with fallback list
UX Issues:

Issue	Line	Severity
Fonts fetched on every mount — each RenderCustomization instance calls get_system_fonts independently; no caching	L38-L49	Medium
Native <input type='range'> and <select> — inconsistent with Radix Slider and Select used elsewhere	L164, L193	Low
Color picker is tiny (h-8 w-12) — hard to click on touch devices	L129	Low
No undo for customizations — changes are immediately saved to state	N/A	Low
2.9 Topbar (topbar.tsx)
Purpose: Image open/paste, pipeline stage viewer, global font size controls, theme toggle, settings access.

Strengths:

Clipboard paste support — innovative for quick image loading
Pipeline stage viewer — toggle between Original/Textless/+Backgrounds/Final views
Smart stage filtering — hides "+Backgrounds" for LaMa modes
Global font size adjustment with step control
UX Issues:

Issue	Line	Severity
alert() for errors — uses native alert() instead of Radix toast/callout for image open/paste errors	L26, L43	Medium
Open Image button has no label — just an icon, no tooltip	L66	Medium
Font size controls only visible when translations exist — no label explaining what these do	L92-L113	Medium
Font Size Step control uses raw HTML <input type='number'> — inconsistent with Radix elsewhere	L99-L106	Low
Paste button has no tooltip — clipboard icon with no explanation	L69	Low
2.10 Tools (tools.tsx)
Purpose: Vertical toolbar for switching between pipeline stages.

Strengths:

Clean icon-button layout with active state highlighting
Tooltips with title attribute
UX Issues:

Issue	Line	Severity
"Segmentation" tool is dead — No panel renders for it, creates an empty sidebar	L26-L29	High
No visual pipeline progress — no indication of which stages have been completed	N/A	Medium
No numbering or flow arrows — user has no visual guide for the intended order	N/A	Medium
No dark mode support — hardcoded bg-gray-50 without dark variant	L47	Low
Tooltip format is odd — "detection: Detect text blocks in the image" with redundant prefix	L52	Low
2.11 Settings Dialog (settings-dialog.tsx)
Purpose: Configure translation API keys, default font, OCR engine, and GPU preferences.

Strengths:

Tabbed organization — Translation, Render/Text, OCR Engine, GPU & Performance
API key testing with visual success/error feedback
Provider-specific instructions with step-by-step guides
Security notice about key storage
GPU troubleshooting guide with collapsible details
Font preview with bilingual sample text
Cancel/Save flow — proper discard on cancel
UX Issues:

Issue	Line	Severity
System fonts loaded redundantly — same invoke('get_system_fonts') called here AND in every RenderCustomization mount	L111-L123	Medium
Ollama has no "test connection" button — can test Google/DeepL keys but not Ollama connectivity	L38-L52	Medium
OCR engine change note is vague — "requires reloading the current image" but doesn't auto-reload or provide a button for it	L476-L481	Medium
GPU change requires app restart — no way to hot-reload GPU provider	L497-L502	Low
API keys stored in Zustand (memory) — lost on page refresh; no persistence mechanism visible	N/A	High
2.12 GPU Status Panel (gpu-status-panel.tsx)
Purpose: Show GPU acceleration status, run stress tests, provide troubleshooting.

Strengths:

Comprehensive diagnostics — provider, device name, warmup time, available providers list
Visual stress test — bar chart of iteration timings with performance verdict badges
Contextual warnings — different messages for fallback, slow warmup, GPU failure
Actionable troubleshooting — specific CUDA/DirectML/verification steps
UX Issues:

Issue	Line	Severity
Error state overrides stress test error — error variable shared between initial load and stress test	L37-L39	Low
No auto-refresh — status is fetched once on mount, stale if GPU state changes	L41	Low
3. Cross-Cutting Concerns
3.1 Error Handling Quality
Component	Error Display	Rating
Detection Panel	console.error only	❌ Poor
OCR Panel	console.error only	❌ Poor
Translation Panel	Callout with specific messages	✅ Excellent
Inpaint Panel	Callout with error details	✅ Good
Render Panel	Callout for processing, console.error for export	⚠️ Mixed
Topbar (image load)	alert()	⚠️ Acceptable but inconsistent
3.2 Loading State Management
Component	Loading Indicator	Progress	Cancel
Detection Panel	Button spinner	❌ No progress	❌ No cancel
OCR Panel	Button spinner	❌ No block progress	❌ No cancel
Translation Panel	Button spinner	✅ Block counter	❌ No cancel
Inpaint Panel	Button spinner	✅ Progress bar	✅ Cancel button
Render Panel (process)	Button spinner	✅ Progress bar	❌ No cancel
Render Panel (export)	❌ No indicator	❌	❌
3.3 Accessibility
Good:

OCR panel text blocks have role='textbox', tabIndex, keyboard handlers
Sidebar collapse button has aria-label and aria-expanded
Resize handle has role='separator' and aria-orientation
Theme toggle has descriptive title
Missing:

No aria-label on any slider (confidence, NMS, selection sensitivity, font size, etc.)
No aria-live regions for status updates (block counts, progress, errors)
Tool buttons rely on title attribute only — no aria-label
Color pickers (native <input type='color'>) have no labels
No skip-to-content or landmark navigation
No focus management after operations complete (e.g., after detection runs, focus doesn't move to results)
3.4 State Persistence
The app uses Zustand without any persist middleware. This means:

API keys are lost on refresh/restart — critical for a desktop app
All progress is lost — detected blocks, OCR text, translations, everything
Settings (theme, GPU, font, OCR engine) — all reset
4. Key UX Improvement Recommendations
P0 — Critical Fixes
Fix the render-panel.tsx import syntax error at L7-L8 — broken/duplicate import
Remove or map the "Segmentation" tool — it's a dead button that confuses users (tools.tsx#L26-L29)
Add error display to Detection and OCR panels — users currently get silent failures
Add state persistence — at minimum for API keys, settings, and GPU preference (use zustand/middleware persist or Tauri's Store plugin)
P1 — High Impact
Reorder tools to match pipeline: Detection → OCR → Translation → Inpaint → Render (or merge OCR into detection and remove the segmentation dead tool)
Add pipeline progress indicator — badge/checkmark on each tool icon showing completion status
Add toast/notification system — replace alert() and console.error with consistent UI feedback
Deduplicate inpainting code — extract shared logic between runLocalizedInpainting and runNewLamaInpainting
Cache system fonts — fetch once at app level, not per-component mount
Add Ollama connection test in settings
P2 — Polish
Add loading/progress to OCR — "Processing block 3/12..." like translation panel
Add cancel to OCR and Translation
Add export loading indicator in render panel
Add "skip already translated" option for translation re-runs
Add undo support for block deletion/editing
Consistent component usage — replace native <select>, <input type='range'>, <input type='number'> with Radix equivalents
Add aria-label to all interactive elements — sliders, buttons, color pickers
Remove ~200 lines of commented-out debug code from render-panel.tsx
Add onboarding/empty state — when no image is loaded, show clear "Open an image to get started" with drag-and-drop support
Unified max-height — OCR uses max-h-[600px], Translation uses max-h-[800px] — should be consistent or dynamic

Translation Pipeline Analysis — Koharu
1. Supported Providers
Provider	Frontend handler	Backend command	API type
Google Cloud Translation v2	translateWithGoogle() in translation.ts	None (direct fetch from frontend)	REST, browser-side
DeepL Free	translateWithDeepL()	translate_with_deepl in commands.rs	REST via Tauri (CORS bypass)
DeepL Pro	same, usePro=true	same, different base URL	REST via Tauri
Ollama (local LLM)	translateWithOllama()	translate_with_ollama in commands.rs	REST to localhost:11434
2. How Each Provider's API Call Works
Google — Direct browser fetch to https://translation.googleapis.com/language/translate/v2?key=.... API key goes in the query string (standard for Google Cloud). Sends { q, source, target, format: "text" }. No Tauri backend involvement.

DeepL — Cannot call from browser due to CORS. Frontend invokes Tauri command translate_with_deepl, which uses reqwest::Client on the Rust side. Sends { text: [string], target_lang, source_lang? } with DeepL-Auth-Key header. Properly switches between api-free.deepl.com and api.deepl.com.

Ollama — Frontend invokes translate_with_ollama. Rust sends POST http://localhost:11434/api/chat with { model, messages, stream: false }. Optional system prompt added as a "system" role message.

3. Error Handling Quality
Provider	Quality	Notes
Google	Good	Catches TranslationAPIError from API JSON, wraps unknown errors. Validates empty input and missing key.
DeepL (frontend)	Good	Pattern-matches Tauri string errors for 403/429/456 codes. Specific user messages for quota exceeded.
DeepL (backend)	Good	Matches HTTP 401/403/429/456 with clear messages. Generic fallback for other codes.
Ollama (frontend)	Adequate	Detects connection failure. Doesn't distinguish model-not-found vs. other errors.
Ollama (backend)	Weak	Only checks status.is_success() — no distinction between model-not-found (404), invalid request (400), or server error (500).
Issues:

commands.rs line ~1375: Ollama error handling is a generic catch-all. A 404 ("model not found") looks the same as a 500.
No timeout is set on the reqwest::Client for either DeepL or Ollama. An unresponsive Ollama server will hang the UI indefinitely.
4. Rate Limiting & Retry Logic
Current state: Minimal.

translation-panel.tsx line ~93: A fixed 100ms delay between blocks (await new Promise(resolve => setTimeout(resolve, 100))).
translation.ts batchTranslate(): Has a delayMs parameter (default 100ms), but is never actually called — the translation panel rolls its own loop instead.
No exponential backoff. If a 429 is returned, the entire batch throws immediately. No retry.
No concurrency control. Requests are sequential (fine for rate limiting but slow for Google which allows batching).
5. System Prompt Engineering
Current state: User-configurable but empty by default.

Ollama system prompt is loaded from localStorage (defaults to '').
If empty, no system prompt is sent at all — the raw OCR text is the only message. This means translation quality depends entirely on the user knowing to configure a prompt.
There's no built-in manga-specific default like:
You are a Japanese-to-English manga translator. Translate the given Japanese text naturally. 
Preserve speech patterns, honorifics, and emotional tone. Output only the translation, no explanations.
Google and DeepL have no prompt engineering (expected — they're translation APIs, not LLMs).
6. Security Issues
Issue	Severity	Location
Google API key in URL query string	Medium	translation.ts line ~58 — url.searchParams.append('key', apiKey). While standard for Google Cloud, the key could be logged in browser history, Tauri devtools, or proxy logs.
API keys in localStorage	Medium	state.ts lines 138-148 — localStorage.getItem('google_translate_api_key'). localStorage is unencrypted and accessible to any JS on the page. Tauri's tauri-plugin-store or OS keychain would be safer.
DeepL API key sent over Tauri IPC	Low	Fine for desktop app, but the key travels as a plain string through the IPC boundary.
No key masking in logs	Medium	commands.rs line ~1250: tracing::debug!("DeepL request: endpoint={}, use_pro={}, body={:?}", ...) — The DeepLRequest struct is Debug-derived and logged, which doesn't include the key directly, but the Authorization header is not explicitly scrubbed.
7. Missing Features
Feature	Impact	Notes
Batch API calls	High	Google Translation v2 supports q as an array. Currently sends one request per text block. Could batch all blocks in a single request, cutting latency by N×.
DeepL batch mode	High	DeepL's text field already accepts arrays in the Rust struct (text: Vec<String>), but translateWithDeepL only sends one string. A single API call could translate all blocks.
Language auto-detection	Medium	DeepL supports source_lang: null for auto-detect (already wired up). Google also supports omitting source. Neither is exposed to the user.
Retry with backoff	Medium	No retry on transient failures (429, 5xx).
Request timeout	Medium	reqwest::Client::new() has no timeout. Ollama LLM inference can take 30+ seconds; should have a configurable timeout.
Translation caching	Medium	Re-translating the same text wastes API quota. A simple Map<string, string> cache would help.
batchTranslate() is dead code	Low	The utility function exists but the panel duplicates its logic.
Configurable Ollama endpoint	Low	Hardcoded to localhost:11434. Users running Ollama on another machine or port are stuck.
Provider-specific language code mapping	Low	Google uses en, DeepL uses EN-US. The translate() function handles this, but it's fragile — adding a new target language requires knowing the mapping.
8. Performance Optimization Opportunities
Google batch request — Send all texts in one call:

body: JSON.stringify({
  q: texts,  // array of strings instead of single string
  source: 'ja', target: 'en', format: 'text',
})
This would reduce N API calls to 1.

DeepL batch request — The Rust struct already uses Vec<String>:

let request_body = DeepLRequest {
    text: all_texts,  // send everything at once
    target_lang: target,
    source_lang: source,
};
Ollama: parallel requests — For multi-block translation, could send concurrent requests (LLMs process independently). Would need a semaphore to limit concurrency.

reqwest Client reuse — Both translate_with_deepl and translate_with_ollama create a reqwest::Client::new() on every call. This allocates a new connection pool each time. Should use a shared client stored in AppState.

Remove duplicate loop — The translation panel reimplements what batchTranslate() already does. Use the existing utility function.

9. Code Quality Issues
Issue	Location	Fix
Dead code: batchTranslate() is never used	translation.ts L252	Either use it in translation-panel or remove it
batchTranslate doesn't pass ollamaModel/ollamaSystemPrompt	translation.ts L300	translate(text, provider, apiKey) is called without the Ollama-specific params — would fail for Ollama provider
Dynamic import on every call	translation.ts L121, L174	await import('@tauri-apps/api/core') is called per translation. Should be a top-level import or cached.
Inconsistent DeepL source_lang handling	translation.ts L111	Parameter is `string
No input sanitization	Multiple	OCR output can contain control characters, zero-width spaces, etc. These should be stripped before sending to APIs
reqwest Client created per-request	commands.rs L1260, L1360	Should be a shared reqwest::Client in AppState — creating one allocates TLS context + connection pool
Ollama URL hardcoded	commands.rs L1339	"http://localhost:11434/api/chat" — should be configurable
No request timeout	Both backend functions	Add .timeout(Duration::from_secs(60)) to the reqwest builder
Summary of Priority Fixes
High — Add request timeouts to both Rust commands (prevents hung UI)
High — Implement batch API calls for Google and DeepL (performance, quota savings)
High — Reuse reqwest::Client via AppState (memory + connection efficiency)
Medium — Add a default system prompt for Ollama (translation quality)
Medium — Add retry with exponential backoff for 429/5xx errors
Medium — Move API keys from localStorage to Tauri secure store
Low — Delete or fix batchTranslate() dead code
Low — Make Ollama endpoint configurable
Low — Cache top-level @tauri-apps/api/core import


LaMa Inpainting Model — Detailed Analysis
1. Model Architecture & I/O Specification
The LaMa (Large Mask Inpainting) model is loaded from HuggingFace (mayocream/lama-manga-onnx, file lama-manga.onnx) — a manga-specialized variant.

Inputs (lib.rs L128-L145):

Name	Shape	Type	Range
image	[1, 3, 512, 512]	f32	[0.0, 1.0] (normalized)
mask	[1, 1, 512, 512]	f32	{0.0, 1.0} (binary)
Output (lib.rs L148-L149):

Name	Shape	Type	Range
output	[1, 3, 512, 512]	f32	[0.0, 1.0]
The model is hardcoded to 512×512. The _target_size parameter at line 110 is explicitly ignored (commented as such at lines 111-113).

2. Pre-processing Pipeline
resize_with_padding (lines 13-77):

Aspect-ratio-preserving resize: Scale longest side to 512, compute short side proportionally (lines 21-29)
Reflection padding: Fill right/bottom gaps with mirrored pixel data (lines 48-71)
Filter: CatmullRom (high-quality bicubic) for image; also CatmullRom for mask (line 120)
Normalization: Pixel values divided by 255.0 → [0, 1] range (lines 131-135)
Mask binarization: pixel[0] > 0 → 1.0, else 0.0 (line 143)
Channel layout: NCHW (batch, channel, height, width)
3. Post-processing Pipeline
(lines 150-175):

Extract f32 tensor → multiply by 255, clamp [0, 255], round to u8
Build RgbImage (no alpha channel)
revert_resize_padding (lines 79-92): Crop padding off, then resize_exact back to original dimensions using CatmullRom
In the calling pipeline (commands.rs L722-L743), there's an additional safety resize if the LaMa output dimensions don't match expected crop dimensions.

4. ONNX Session Configuration
(lines 99-105):

Session::builder()?
    .with_optimization_level(GraphOptimizationLevel::Level3)?  // Maximum optimization
    .with_intra_threads(thread::available_parallelism()?.get())?  // All CPU cores
    .commit_from_file(model_path)?;
Setting	Value	Assessment
Optimization	Level3 (max)	Good
Intra-threads	All available cores	Good for CPU, but see issue below
CUDA/GPU	NOT configured	MAJOR ISSUE
Inter-threads	Default (1)	Acceptable
No execution provider is specified — the session defaults to CPUExecutionProvider. Unlike the OCR pipeline (commands.rs L46) and detection model which respect CUDA configuration, LaMa runs on CPU only. This is a significant performance bottleneck for a computationally expensive inpainting model.

5. Memory Management
Aspect	Assessment
Model lifetime	Single Session stored in AppState behind Mutex<Lama> — good, no reload per call
Tensor allocation	ndarray::Array::zeros allocates fresh tensors per call (lines 126-127) — acceptable
Image copies	Multiple intermediate allocations: resize → pad → pixel iteration → RgbImage → DynamicImage → resize back
Pixel iteration	Uses .pixels() iterator which is safe but slower than raw buffer access
6. inference_with_size vs inference
inference_with_size (lines 108-175): The real implementation. The _target_size parameter is dead code — always uses 512. This is misleading API design.
inference (lines 178-183): Trivial wrapper calling inference_with_size(image, mask, 512).
The calling code in commands.rs L701 passes cfg.target_size which is silently ignored. Users may think they're controlling resolution but they're not.

7. Issues Found
CRITICAL
#	Lines	Issue	Description
C1	99-105	No GPU/CUDA support	LaMa session doesn't configure any execution provider. Runs on CPU only even when CUDA is available. Inpainting is the most compute-heavy operation in the pipeline. Other models (detection, OCR) use CUDA.
HIGH
#	Lines	Issue	Description
H1	110	Dead parameter _target_size	Parameter is accepted but ignored. Callers (e.g., commands.rs:701) pass configurable values thinking they matter. This is a correctness/API honesty issue.
H2	120	CatmullRom filter on mask	Mask is resized with CatmullRom (smooth interpolation) which creates anti-aliased edges (gray values between 0-255). Then at line 143, values > 0 become 1.0. This means the mask bleeds outward — any sub-pixel spillover gets rounded up to "inpaint this pixel". Should use Nearest for mask resize to keep binary edges crisp.
H3	126-143	Slow pixel-by-pixel tensor fill	Uses .pixels() iterator with per-pixel indexing into ndarray. For 512×512 = 262,144 pixels × 3 channels, this is ~786K individual array index operations. Raw buffer access with chunks_exact would be significantly faster.
MEDIUM
#	Lines	Issue	Description
M1	48-71	Reflection padding corner gap	Right padding only iterates y in 0..new_height, bottom padding iterates x in 0..target_size. The bottom-right corner is filled by the bottom pass. But if both pad_right > 0 and pad_bottom > 0, the bottom-right corner pixels are reflected from already-reflected right-padding pixels — a double reflection. Minor visual artifact risk.
M2	95-105	No model caching / path check	hf_hub::Api does HTTP HEAD on every Lama::new(). If HuggingFace is unreachable, this hangs (mitigated by 120s timeout in lib.rs L236-L244). Could check local cache first.
M3	150-163	Output pixel loop redundancy	Allocates a new RgbImage and fills pixel-by-pixel. Could construct directly from the output tensor buffer with a single pass.
M4	96	&mut self unnecessarily	inference_with_size takes &mut self but doesn't mutate self. The Session::run method likely only needs &self. This forces exclusive Mutex locking in the caller, preventing any concurrency.
LOW
#	Lines	Issue	Description
L1	1	No GPU feature flag	No conditional compilation or GPU configuration unlike other model crates.
L2	154-160	No alpha channel preservation	Output is RGB, not RGBA. Alpha is added later in commands.rs pipeline, but any alpha information from the source is lost. Acceptable for inpainting but worth noting.
L3	Cargo.toml	Unused dependency: clap	clap is only used in main.rs (CLI tool), but it's a non-optional dependency. Should be behind a cli feature or only in [[bin]] dependencies.
8. Image Size Handling
The pipeline handles arbitrary sizes through a resize→pad→infer→unpad→resize chain:

Input: Any (W, H) image
Resize: Longest side → 512, aspect ratio preserved (lines 20-29)
Pad: Short side reflection-padded to 512 (lines 44-71)
Infer: Fixed 512×512
Unpad: Crop to (resized_W, resized_H) (line 86)
Resize back: resize_exact to (W, H) (line 89)
Quality concern: Small crops (e.g., 50×30 text bubble) get upscaled 10× to 512, inpainted, then downscaled 10×. Two resampling passes degrade quality. The calling pipeline in commands.rs already crops to individual text blocks with padding, so actual inputs are typically small regions — this is suboptimal for the model.

9. Error Handling Quality
Aspect	Rating	Notes
Model loading	Good	Uses anyhow::Result, propagates errors with ?
Input validation	Poor	No checks for zero-dimension images, no check that image and mask have same dimensions
Inference errors	Good	Propagated via ? operator
Output validation	None	No NaN/Inf checks on model output
Caller-level	Excellent	commands.rs has thorough buffer length validation, dimension overflow checks, and fallback resize
Missing validations in lib.rs:

No check: image.dimensions() == mask.dimensions() before processing
No check: image has non-zero dimensions
No NaN/Inf guard on output tensor values (if model produces garbage, clamp handles finite values but NaN would propagate as 0 via .round() as u8)
Summary of Recommendations (Priority Order)
Add CUDA execution provider to the Session::builder — this is likely a 5-20× speedup
Use Nearest filter for mask resizing to prevent mask bleed
Remove or properly implement target_size parameter — either support variable model sizes or remove the parameter entirely
Change &mut self to &self on inference methods if Session::run allows it — enables concurrent inpainting
Optimize pixel loops with raw buffer access instead of per-pixel indexing
Add input validation (matching dimensions, non-zero size)


MangaOCR Implementation Analysis
1. Model Architecture: ViT Encoder + Autoregressive Decoder
The model is a Vision Transformer (ViT) encoder + sequence decoder architecture, split into two ONNX files:

encoder_model.onnx — Takes pixel_values (1×3×224×224), produces hidden states (lib.rs L68-L72)
decoder_model.onnx — Takes encoder_hidden_states + input_ids, produces logits over the vocabulary (lib.rs L78-L86)
This matches the kha-white/manga-ocr architecture (ViT-based encoder, TrOCR/BERT-style decoder), exported to ONNX by the mayocream/manga-ocr-onnx repo.

2. Pre-processing Pipeline
Step	Location	Details
Grayscale conversion	L49	image.grayscale().to_rgb8() — converts to grayscale then back to 3-channel RGB
Resize	L50-L51	Fixed 224×224 with Lanczos3
Normalization	L58-L62	(pixel/255.0 - 0.5) / 0.5 → maps [0,255] to [-1,1]
Tensor layout	L54	NCHW: (1, 3, 224, 224)
Severity: LOW — The grayscale→RGB conversion is intentional (manga-ocr was trained on grayscale images but the ViT expects 3 channels). All 3 channels will be identical.

3. Inference Pipeline (Autoregressive Decoding)
Lines 75-97:

Start token [2] → decoder → logits → argmax → append token → repeat until [3] or 300 steps
Start token: 2 (CLS/BOS) — L75
End token: 3 (SEP/EOS) — L95
Max length: 300 tokens — L77
Decoding strategy: Pure greedy argmax — L89-L93
No beam search, no temperature, no top-k/top-p sampling
4. Post-processing (Token Decoding)
Lines 99-105:

Filters out tokens with id < 5 (skips PAD=0, UNK=1, CLS=2, SEP=3, MASK=4)
Looks up each token in vocab by index
Joins all tokens with empty separator (correct for Japanese subword tokenization)
5. ONNX Session Configuration
Lines 23-30:

Setting	Value	Assessment
Optimization	Level3 (max)	Good
Threading	available_parallelism() (all cores)	Good
Execution Provider	CPU only	See issue #1 below
6. Performance Characteristics & Bottlenecks
Bottleneck	Severity	Location	Details
No CUDA/GPU	HIGH	L23-L30	Encoder & decoder sessions use CPU only. The global EP configured in lib.rs is NOT inherited because MangaOCR::new() builds its own sessions.
Quadratic decoder cost	MEDIUM	L77-L97	Each step re-runs the full decoder with the entire input_ids sequence (no KV-cache). For N tokens, total work is O(N²).
No KV-cache	MEDIUM	L78-L86	The decoder recomputes attention from scratch every step. If the ONNX model supports past_key_values, they're not used.
Redundant allocations	LOW	L79	token_ids.clone() on every iteration creates a new Vec.
Encoder runs once	Good	L68-L72	Encoder hidden state is computed once and reused.
7. Bugs & Issues
Issue #1: NO GPU ACCELERATION (Severity: HIGH)
Lines 23-30: MangaOCR::new() creates its own ONNX sessions with no execution provider configuration. The app's global CUDA EP (configured in src-tauri/src/lib.rs) is not inherited because ort sessions must be explicitly configured with an EP.

The rest of the app's models (detection, PaddleOCR, LaMa) all get CUDA. MangaOCR is silently CPU-only.

Fix: Accept an EP parameter or use SessionBuilder::with_execution_providers().

Issue #2: partial_cmp().unwrap() on floats (Severity: MEDIUM)
Line 91: a.partial_cmp(b).unwrap() will panic if any logit is NaN. With neural network outputs, NaN can occur from degenerate inputs or model corruption.

Fix: Use .unwrap_or(std::cmp::Ordering::Equal) or handle NaN explicitly.

Issue #3: No bounds check on vocab lookup (Severity: MEDIUM)
Line 102: self.vocab.get(id as usize) — while .get() is safe (returns None), a model producing token IDs outside the vocab range would silently drop tokens with no logging or warning. Combined with .filter_map(), bad tokens are invisible.

Issue #4: Negative token IDs cast to usize (Severity: LOW)
Line 102: Token IDs are i64. If the model ever produces a negative value, id as usize on a negative i64 wraps to a huge number, which .get() would return None for. Silent failure.

Issue #5: &mut self unnecessarily required (Severity: LOW)
Line 47: inference(&mut self, ...) takes &mut self but nothing is mutated. The Session::run() method in ort v2 takes &self. This forces the caller to use a Mutex needlessly (as seen in ocr_pipeline.rs L318).

Fix: Change to &self.

Issue #6: Max token limit is 300 — excessive (Severity: LOW)
Line 77: Manga text bubbles rarely exceed ~50 characters. 300 iterations with no KV-cache means up to 300 full decoder forward passes for a runaway generation. A limit of 64-128 would be safer.

8. Error Handling
Aspect	Assessment
Model loading	Good — uses anyhow::Result, custom error messages for vocab (L33-L34)
Inference	Partial — unwrap() on argmax (L93) can panic on empty logits
HF download	Good — caller (lib.rs) wraps in 30s timeout (src-tauri/src/lib.rs L272-L274)
Token decoding	Silent failures — no logging for out-of-vocab tokens
9. Memory Management
Session persistence: Both encoder and decoder Session objects live for the app lifetime in MangaOcrPipeline.inner — correct, avoids reloading.
Tensor allocation: A new (1, 3, 224, 224) tensor is allocated per inference call (L54). Could reuse a buffer, but impact is trivial (~600KB).
Token vec cloning: token_ids.clone() per decoder step (L79) — minor, typically <300 i64s.
No explicit cleanup: Relies on Drop — fine for ONNX sessions.
10. OcrPipeline Trait Implementation
ocr_pipeline.rs L362-L385:

Method	Behavior	Assessment
detect_text_regions()	Returns a single region covering the entire image	Correct — MangaOCR doesn't detect, it only recognizes. The caller is expected to provide pre-cropped text regions.
recognize_text()	Runs inference on the full image, returns the same text for ALL regions	BUG (MEDIUM) — If multiple regions are passed, it runs inference once but clones the result for every region. It should run inference on each cropped region individually.
The recognize_text implementation at L382 ignores region bounding boxes entirely:

let text = guard.inference(image)?;          // runs on full image
Ok(regions.iter().map(|_| text.clone()).collect())  // same text for all regions
Summary of Issues by Severity
#	Severity	Issue	Location
1	HIGH	No GPU acceleration — CPU-only sessions	lib.rs L23-30
2	HIGH	recognize_text ignores regions, returns same text for all	ocr_pipeline.rs L379-L383
3	MEDIUM	partial_cmp().unwrap() panics on NaN logits	lib.rs L91
4	MEDIUM	No KV-cache → O(N²) decoder cost	lib.rs L77-L97
5	MEDIUM	Silent token drops (no logging for OOV tokens)	lib.rs L100-L103
6	LOW	&mut self unnecessarily required	lib.rs L47
7	LOW	Max tokens 300 is excessive	lib.rs L77
8	LOW	Negative i64 token IDs silently wrap on usize cast	lib.rs L102


Koharu Build System & Dependency Analysis
1. Workspace Structure & Dependency Management
Structure: Well-organized 4-crate workspace (comic-text-detector, lama, manga-ocr, src-tauri) with centralized workspace dependencies. The bun workspaces for JS ("workspaces": ["next"]) are also correctly set up.

Issues:

resolver = "3" + edition = "2024": These require Rust 1.85+. Ensure your CI/CD and all developers are on this version. This is fine if intentional, but locks out anyone on older toolchains.

Workspace version (0.1.11) vs Next.js version (0.1.0): These are out of sync. The root package.json has no version field at all. Consider unifying.

2. Feature Flags
Feature	Enables	Notes
cuda	ort/cuda, nvml-wrapper	Default feature
directml	ort/directml	Alternative GPU backend
Issues:

default = ["cuda"] — A plain cargo build or cargo test will require CUDA to be installed. This will break for contributors without NVIDIA hardware. Recommendation: remove cuda from defaults and always pass --features=cuda explicitly (which your build command already does: bun tauri build -- --features=cuda). Having it in both places is redundant and the default hurts portability.
3. Build Optimization Settings
# Current release profile
codegen-units = 4   # Good balance
lto = "thin"        # Good — parallel, nearly as good as fat
opt-level = "s"     # ⚠️ Optimizes for SIZE, not speed
panic = "abort"     # Good — smaller binary, faster
strip = true        # Good — removes debug symbols
Issues:

opt-level = "s" is wrong for an ML inference app. This project runs ONNX Runtime inference, image processing, and text detection. opt-level = "s" sacrifices runtime speed for smaller binaries. For ML workloads, opt-level = 3 (or even 2) would give meaningfully better performance. The binary size difference is typically 10-20%, but the speed difference can be 15-30% for compute-heavy code.

The dev-release profile is defined but never referenced in any build scripts or documentation. It's a great idea but unusable until documented. Add a script: "build:fast": "cd next && bun run build && cd ../src-tauri && cargo build --profile dev-release --features=cuda".

Missing [profile.dev.package."*"] optimization: Dependencies like image, ndarray, and ort are extremely slow in debug mode. Add:

[profile.dev.package."*"]
opt-level = 2  # Optimize deps even in dev mode
This dramatically improves bun tauri dev iteration speed at minimal compile cost.

4. Dependency Versions — Critical Issues
CRITICAL: ndarray version conflict
Location	Version
Cargo.toml (workspace)	ndarray = "0.16.1"
src-tauri/Cargo.toml	ndarray = "0.15"
src-tauri declares its own ndarray = "0.15" without workspace = true, while the workspace defines 0.16.1. The subcrates (comic-text-detector, lama, manga-ocr) use the workspace version 0.16.1. This means two different versions of ndarray are compiled and linked, bloating the binary and potentially causing type mismatches when passing arrays between crates.

Fix: Change src-tauri/Cargo.toml to ndarray = { workspace = true }.

Pinned release candidate: ort
ort = "=2.0.0-rc.10" is pinned to a release candidate with = exact version. Ort 2.0 stable has been released. Pinning to an RC means:

No security/bugfix updates
Potential API breakage when upgrading later
The = pin prevents even patch updates
Fix: Upgrade to ort = "2.0" (stable) or at minimum "2.0.0-rc.10" without the = pin.

Other version concerns
Dependency	Current	Status
wgpu	0.19	Very outdated — wgpu has reached 24.x. 0.19 is years old.
candle-transformers	0.9.1	Check if still used — search for actual usage. May be dead code from early prototyping.
hf-hub	0.4.2	Moderately old; newer versions have better caching.
image	0.25.6	Current as of its major line. Fine.
tauri	"2"	Very loose — will auto-upgrade to 2.x. Consider pinning to "~2.x".
font-kit	0.14.2	Fine.
reqwest	0.12	Fine. Uses rustls-tls — good.
wgpu = "0.19" deserves special attention
This crate is enormous and slow to compile. If it's only used for GPU status detection or a minor feature, consider whether it's worth the compile time cost. Search for actual usage to determine if it can be removed or replaced with a lighter alternative.

5. Tauri Configuration Issues
CRITICAL: Invalid identifier
"identifier": "koharu"
Tauri v2 requires a reverse-domain identifier (e.g., com.koharu.app or dev.koharu.translator). A bare name may work locally but will fail for:

macOS app bundling
Windows MSIX packaging
Any app store submission
Fix: Change to "identifier": "com.koharu.app" or similar.

Missing version field
The tauri.conf.json has no version. It should match the workspace version 0.1.11 or be set explicitly.

Security — Extremely Permissive (see §9)
Covered in detail below.

Bundle targets
"targets": "all"
This builds MSI, NSIS, and potentially other formats. If you only need one installer type, specify it to save 30+ seconds on each build.

6. Next.js Configuration
output: 'export'  // Only in production — correct for Tauri
distDir: 'dist'   // Matches tauri.conf.json frontendDist — correct
reactStrictMode: false  // ⚠️
Issues:

reactStrictMode: false: Strict mode helps catch bugs like missing cleanup in effects, double-rendering issues, and deprecated API usage. It has zero production cost. Recommendation: enable it unless there's a specific Konva/react-konva incompatibility forcing it off.

No images configuration: With static export, Next.js <Image> component won't work with the default loader. If you use <Image>, you need images: { unoptimized: true }. If you only use <img> or Konva, this is fine.

No TypeScript strict mode verification: Check that tsconfig.json has "strict": true.

7. Duplicate & Unnecessary Dependencies
Duplicates that should be workspace dependencies
Dependency	Declared in	Should be
unicode-segmentation = "1.10"	src-tauri + manga-ocr	Workspace dep
sha2 = "0.10"	src-tauri + manga-ocr	Workspace dep
ndarray	0.15 in src-tauri, 0.16.1 in workspace	Fix version conflict
criterion = "0.5"	src-tauri + manga-ocr dev-deps	Workspace dev-dep
tempfile = "3.8"	src-tauri + manga-ocr dev-deps	Workspace dev-dep
Potentially unnecessary
Dependency	Concern
candle-transformers	Only in comic-text-detector. Verify it's actually used — ONNX Runtime handles inference, so Candle may be vestigial.
wgpu = "0.19"	Heavy compile-time cost. What's it used for? If only GPU detection, nvml-wrapper already covers NVIDIA GPUs.
staticlib in crate-type	crate-type = ["staticlib", "cdylib", "rlib"] — Tauri only needs cdylib and rlib. The staticlib adds compile time for no benefit.
browser-fs-access	JS dep — Tauri has its own file dialog. May be unused if you switched to tauri-plugin-dialog.
async-trait	With Rust 2024 edition, native async fn in traits is stabilized. This crate may be unnecessary.
8. Build Time Optimization Opportunities
Optimization	Impact	Effort
Remove staticlib from crate-type	~5-10% link time reduction	Trivial
Add [profile.dev.package."*"] opt-level = 2	5-10x faster dev runtime	Trivial
Remove/replace wgpu if underused	~30-60s less compile time	Medium
Remove candle-transformers if unused	~20-30s less compile time	Verify first
Fix ndarray duplication	Less compilation, smaller binary	Trivial
Upgrade ort to stable	Better optimization from newer LLVM passes	Medium
Use --no-bundle for testing	Skip MSI/NSIS generation (~30s)	Already documented
Target specific bundle format	Skip unwanted installers	Trivial
Remove async-trait (Rust 2024 has native async traits)	Minor	Easy
9. Security Considerations
CRITICAL: CSP is effectively disabled
"dangerousDisableAssetCspModification": true,
"csp": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"
This CSP allows:

Loading scripts/resources from any origin (*)
Inline scripts (unsafe-inline) — enables XSS
eval() and related (unsafe-eval) — enables code injection
Data URIs and blobs — can be used for exfiltration
For a desktop app processing local files, a tight CSP is feasible:

"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset:; connect-src 'self' https://*.googleapis.com https://generativelanguage.googleapis.com"
Add specific domains for any APIs you call (Gemini, etc.).

Asset protocol scope is too broad
"assetProtocol": {
  "enable": true,
  "scope": ["**/*"]
}
This gives the frontend access to every file on the system. Restrict to user-selected directories:

"scope": ["$APPDATA/**", "$RESOURCE/**", "$DOWNLOAD/**"]
Good practices already in place
reqwest uses rustls-tls (no OpenSSL) ✓
tauri-plugin-persisted-scope is included ✓
No hardcoded API keys visible ✓
10. sccache Configuration
.cargo/config.toml:

[build]
rustc-wrapper = "sccache"
Status: Correctly configured. The comments about CUDA/cuDNN runtime paths are helpful.

Issues:

If sccache is not installed, every build will fail with a cryptic error. Add a check in your setup script or document the installation step prominently.
sccache doesn't cache proc-macro crates or build scripts — these always recompile. This is normal.
Consider adding SCCACHE_CACHE_SIZE if the default 10GB is insufficient for CUDA builds.
sccache and CUDA compilation can sometimes conflict. If you see cache misses on CUDA-related crates, you may need SCCACHE_IDLE_TIMEOUT tuning.
Summary: Priority Fixes
Priority	Issue	Fix
🔴 Critical	ndarray version conflict (0.15 vs 0.16.1)	Change src-tauri to { workspace = true }
🔴 Critical	CSP completely disabled	Implement restrictive CSP
🔴 Critical	Asset protocol scope **/*	Restrict to app directories
🟠 High	ort pinned to RC	Upgrade to stable 2.0
🟠 High	opt-level = "s" for ML app	Change to opt-level = 3 or 2
🟠 High	Invalid Tauri identifier	Use reverse-domain format
🟡 Medium	default = ["cuda"]	Remove, use explicit --features=cuda
🟡 Medium	wgpu = "0.19" outdated & heavy	Audit usage, remove or upgrade
🟡 Medium	Duplicate deps not in workspace	Consolidate unicode-segmentation, sha2
🟡 Medium	staticlib in crate-type	Remove — not needed for Tauri
🟢 Low	Missing [profile.dev.package."*"]	Add opt-level = 2 for faster dev
🟢 Low	async-trait with Rust 2024	Remove if possible
🟢 Low	candle-transformers possibly unused	Audit and remove if vestigial



PaddleOCR Integration Analysis
Architecture Overview
The OCR system uses a trait-based engine abstraction (OcrPipeline) allowing runtime switching between PaddleOCR and MangaOCR. Both engines are stored in a HashMap<String, Arc<dyn OcrPipeline>> in AppState and selected via active_ocr: RwLock<String>.

1. Loading & Initialization
File: src-tauri/src/lib.rs

PaddleOCR loads at startup from app_data_dir/models/:

Loads model ONNX files: PaddleOcrPipeline::new(&model_dir, ocr_device_config)
Gracefully degrades: if PaddleOCR fails, app continues with MangaOCR fallback
Default engine priority: PaddleOCR > MangaOCR > first available > empty string
File: src-tauri/src/ocr_pipeline.rs

PaddleOcrPipeline::new() loads:

det.onnx — text detection model
rec.onnx — text recognition model
cls.onnx — angle classification model (optional, per config)
dictionary.txt — character dictionary for CTC decoding
config.json — input shapes, normalization params, thresholds
2. Models Used
Model	File	Purpose
Detection	det.onnx	DBNet-based text region detection
Recognition	rec.onnx	CRNN-based text recognition
Classification	cls.onnx	Text angle classification (0°/180°)
Dictionary	dictionary.txt	Character-to-index mapping for CTC decode
Model config is validated via ModelPackage with SHA-256 checksum verification.

3. Japanese Text Handling
Severity: CRITICAL — Non-functional

The recognition pipeline does not actually recognize Japanese text. Two placeholder implementations exist:

postprocess_detection(): Returns a hardcoded dummy region [10, 10, 100, 30] with confidence 0.9 instead of parsing the detection output tensor. Comment on L231 says: "Placeholder: create dummy regions for now".

postprocess_recognition(): Returns the hardcoded string "recognized_text" instead of performing CTC decoding against the dictionary. Comment on L252 says: "Placeholder: return dummy text for now".

classify_angle(): Sets all angles to 0.0 as a placeholder instead of running the classification model.

The entire PaddleOCR pipeline is a stub. The models load correctly, ONNX inference runs, but output parsing is not implemented.

4. OcrPipeline Trait
File: src-tauri/src/ocr_pipeline.rs

#[async_trait::async_trait]
pub trait OcrPipeline: Send + Sync + std::fmt::Debug {
    async fn detect_text_regions(&self, image: &DynamicImage) -> Result<Vec<TextRegion>>;
    async fn recognize_text(&self, image: &DynamicImage, regions: &[TextRegion]) -> Result<Vec<String>>;
}
Two implementations:

Engine	detect_text_regions	recognize_text
PaddleOcrPipeline	Runs det model (but returns dummy)	Runs rec model (but returns dummy)
MangaOcrPipeline	Returns full-image bbox	Delegates to manga_ocr crate (working)
The MangaOCR implementation at L362-L384 is functional — it doesn't detect regions (returns full image as one region) but does actual text recognition.

5. Results Return to Frontend
File: src-tauri/src/commands.rs

Flow: ocr command → run_ocr_with_pipelines() → execute_ocr_pipeline() → returns OcrRunResult { texts, engine, region_count }

The Tauri ocr command at L183 returns Vec<String> (just the texts). The ocr_cached_block variant at L242 crops from a cached full-resolution image for efficiency.

Fallback mechanism at L91-L104: If the active engine fails, automatically falls back to MangaOCR.

6. Performance & Correctness Issues
#	Issue	Location	Severity
1	Detection postprocessing is a stub — returns hardcoded dummy bbox	ocr_pipeline.rs L228-L243	CRITICAL
2	Recognition postprocessing is a stub — returns "recognized_text" literal	ocr_pipeline.rs L245-L256	CRITICAL
3	Angle classification is a stub — always returns 0°	ocr_pipeline.rs L258-L271	HIGH
4	Dead module: ocr_config.rs exists but is never referenced from lib.rs — duplicates ModelConfig already in model_package.rs	ocr_config.rs	LOW
5	Sequential region processing: recognize_text() processes regions one-at-a-time with mutex lock/unlock per region at L163-L180 — could batch	ocr_pipeline.rs L155-L180	MEDIUM
6	Metadata logging commented out at L95 — no runtime visibility into what EP sessions actually used	ocr_pipeline.rs L95	LOW
7	MangaOCR returns same text for all regions — clones single inference result for every region at L379	ocr_pipeline.rs L374-L381	MEDIUM
8	DeviceConfig::Cuda mapped from "directml" — misleading comment "DirectML uses CUDA provider in ORT" is incorrect	lib.rs L139	MEDIUM
7. CUDA Usage
File: src-tauri/src/ocr_pipeline.rs

PaddleOCR does not configure per-session execution providers. The comment at L45-L46 says:

"Note: ORT execution provider is configured globally in lib.rs. Sessions will inherit the global execution provider automatically"

Sessions are created with bare Session::builder()?.commit_from_file(...) which inherits whatever global EP was set during ORT initialization. So if the app was started with CUDA, PaddleOCR sessions will use CUDA — but there's no explicit EP selection, no fallback, and no verification that GPU is actually being used for these sessions.

The DeviceConfig enum is passed into new() but only used for logging (the execution_provider string field), not for actual EP configuration.

8. Engine Switching
File: src-tauri/src/commands.rs

set_active_ocr command:

Validates the key exists in ocr_pipelines HashMap
Updates active_ocr: RwLock<String>
All subsequent ocr/ocr_cached_block calls read this key to select the pipeline
Frontend doesn't appear to have a UI for switching (no grep matches in ocr-panel.tsx), so this is backend-only functionality currently.

Summary of Critical Findings
PaddleOCR is entirely non-functional — all three post-processing stages (detection, classification, recognition) are placeholder stubs. The models load and inference runs, but outputs are discarded and replaced with hardcoded values.

MangaOCR is the only working OCR engine — and it works by processing one cropped region at a time (the frontend handles region selection via detected bboxes from the comic-text-detector, not from PaddleOCR's detection).

The trait abstraction is well-designed — swapping in a real PaddleOCR implementation only requires implementing postprocess_detection(), postprocess_recognition(), and classify_angle() properly (DB postprocessing, CTC decoding, and angle classification respectively).

No frontend engine selector exists — the set_active_ocr command is registered but not exposed in the UI.




Image Utility Analysis — Koharu
Files Analyzed
File	Purpose
next/utils/image.ts	Image manipulation & conversion (crop, resize, bitmap↔buffer, masks)
next/lib/image.ts	Image type definition + factory constructors
next/utils/writing-mode.ts	CJK vertical/horizontal writing mode heuristic
1. Available Image Operations
Function	Location	Description
crop()	utils/image.ts	Delegates to createImageBitmap sub-rect
resize()	utils/image.ts	Resize via createImageBitmap with resizeQuality: 'high'
imageBitmapToArrayBuffer()	utils/image.ts	Bitmap → PNG ArrayBuffer via OffscreenCanvas
imageBitmapToRgbaUint8()	utils/image.ts	Bitmap → raw RGBA pixels
imageBitmapToGrayscaleUint8()	utils/image.ts	Bitmap → single-channel grayscale (R channel only)
maskToArrayBuffer()	utils/image.ts	Grayscale mask array → PNG ArrayBuffer
maskToUint8Array()	utils/image.ts	Pass-through / convert ArrayLike<number> to Uint8Array
createSegmentationMaskBitmap()	utils/image.ts	Mask → colored overlay ImageBitmap with resize
createImageFromBlob()	lib/image.ts	Load Blob → {buffer, bitmap}
createImageFromBuffer()	lib/image.ts	Load ArrayBuffer → {buffer, bitmap}
detectWritingMode()	utils/writing-mode.ts	CJK aspect-ratio heuristic for vertical/horizontal
2. Image Load/Convert Flow
User drops file → Blob
  → createImageFromBlob() → { buffer: ArrayBuffer, bitmap: ImageBitmap }
    stored in Zustand state.image

For backend calls:
  bitmap → imageBitmapToArrayBuffer() → ArrayBuffer (PNG)
         → Array.from(new Uint8Array(png)) → number[]
         → invoke('command', { imagePng: number[] })

Backend returns:
  Rust Vec<u8> (PNG bytes) → deserialized as number[]
  → new Uint8Array(result).buffer → createImageFromBuffer() → Image
3. Issues & Severity Ratings
CRITICAL — Array.from(new Uint8Array(...)) serialization is extremely wasteful
Severity: CRITICAL (Performance)
Files: inpaint-panel.tsx, ocr-panel.tsx, render-panel.tsx

Every image sent to the backend is converted ArrayBuffer → Uint8Array → Array.from() which creates a plain JavaScript number array. Tauri serializes this as a JSON array of numbers. For a 2000×3000 PNG (3-5 MB), this turns into a **15-25 MB JSON string** (each byte becomes "123," — ~4-5 chars per byte).

This is the single biggest performance bottleneck in the image pipeline. Tauri supports Vec<u8> natively from Uint8Array or base64 — Array.from() is unnecessary.

Fix: Pass Array.from(new Uint8Array(buffer)) → just [...new Uint8Array(buffer)] or, better yet, investigate Tauri v2's binary IPC (raw byte transfer) to avoid JSON serialization entirely.

HIGH — Image.buffer is stored redundantly and can go stale
Severity: HIGH (Memory)
File: next/lib/image.ts

export type Image = {
  buffer: ArrayBuffer
  bitmap: ImageBitmap
}
Both buffer (the raw file bytes) and bitmap (the decoded GPU-resident texture) are kept in memory simultaneously. For a 5 MB manga page:

buffer: ~5 MB
bitmap: ~24 MB (2000×3000×4 RGBA uncompressed)
The buffer is never used again after initial load — it's not referenced anywhere in the codebase for subsequent operations. Everything works from bitmap. This doubles memory usage per loaded image for no benefit.

Additionally, after operations like crop/resize/inpaint that produce a new bitmap, the buffer still holds the original file data, making it stale and misleading.

Fix: Either drop buffer from the type, or make it lazy (recompute on demand for export only).

HIGH — No validation on crop() parameters
Severity: HIGH (Correctness)
File: next/utils/image.ts

export async function crop(
  image: ImageBitmap,
  x: number, y: number, width: number, height: number
): Promise<ImageBitmap> {
  return await createImageBitmap(image, x, y, width, height)
}
No bounds checking. If x + width > image.width or coordinates are negative/fractional, createImageBitmap will throw a cryptic DOMException. The AGENTS.md file explicitly warns about Math.floor pitfalls (Pitfall #5), yet the utility itself doesn't enforce integer coordinates or clamp values.

Fix: Add integer rounding and clamping:

x = Math.max(0, Math.floor(x))
y = Math.max(0, Math.floor(y))
width = Math.min(Math.floor(width), image.width - x)
height = Math.min(Math.floor(height), image.height - y)
MEDIUM — Grayscale extraction uses only R channel
Severity: MEDIUM (Correctness)
File: next/utils/image.ts

for (let i = 0; i < result.length; i++) {
  result[i] = pixels[i * 4]  // Only R channel
}
This is correct only if the source image is already grayscale (R=G=B). For colored images, the proper luminance formula is 0.299R + 0.587G + 0.114B. Currently this would produce incorrect grayscale values for any non-gray pixel. If this function is only used on masks (which are grayscale by construction), it's safe — but the function name and signature suggest general-purpose use.

MEDIUM — imageBitmapToArrayBuffer always encodes as PNG
Severity: MEDIUM (Performance)
File: next/utils/image.ts

const blob = await canvas.convertToBlob({ type: 'image/png' })
PNG encoding is lossless but slow — particularly for large manga pages. For operations where the backend just needs pixel data (not archival quality), JPEG or raw pixel transfer would be 5-10× faster. There is no option to specify format or quality.

MEDIUM — createImageFromBuffer creates an untyped Blob
Severity: MEDIUM (Correctness)
File: next/lib/image.ts

const blob = new Blob([buffer])  // No MIME type specified
The Blob is created without a MIME type. createImageBitmap still works because it sniffs the magic bytes, but this is fragile. If the buffer contains raw pixel data instead of an encoded image, it will silently fail.

LOW — maskToArrayBuffer has hardcoded default dimensions
Severity: LOW (API Design)
File: next/utils/image.ts

export async function maskToArrayBuffer(
  mask: ArrayLike<number>,
  width = 1024,
  height = 1024
): Promise<ArrayBuffer> {
Default dimensions of 1024×1024 are a footgun. If a caller forgets to pass width/height, the mask silently gets the wrong size with no error. The function should require these parameters explicitly or infer them from mask.length.

LOW — No ImageBitmap.close() in crop() and resize()
Severity: LOW (Memory)
File: next/utils/image.ts

The crop and resize functions return a new ImageBitmap but don't close the source. The caller is responsible for lifecycle management, but this isn't documented. The codebase is inconsistent — createSegmentationMaskBitmap properly closes intermediate bitmaps, but these simpler utilities don't mention it.

LOW — writing-mode.ts CJK regex misses some ranges
Severity: LOW (Correctness)
File: next/utils/writing-mode.ts

The CJK regex doesn't cover:

CJK Unified Ideographs Extension B+ (U+20000–U+2A6DF) — rare but valid kanji
CJK Compatibility Ideographs (U+F900–U+FAFF)
Halfwidth Katakana (U+FF65–U+FF9F) — partially covered by \uFF00-\uFF9F
For standard manga this is fine, but edge cases with rare kanji will default to horizontal.

4. Type Safety Assessment
Generally good. Key observations:

The Image type is simple and well-typed
All async functions have explicit return types
SegmentationMaskBitmapOptions uses a proper interface with optional fields and defaults
detectWritingMode returns a union type literal
Weakness: The mask parameter type ArrayLike<number> is too broad — it accepts number[], Float64Array, etc. where only Uint8Array with values 0–255 is meaningful.

5. Summary Table
Issue	Severity	Category	Effort to Fix
Array.from() JSON serialization overhead	CRITICAL	Performance	Medium (needs Tauri IPC research)
Redundant buffer in Image type	HIGH	Memory	Low
No bounds checking in crop()	HIGH	Correctness	Low
Grayscale uses R-channel only	MEDIUM	Correctness	Low
Always PNG encoding	MEDIUM	Performance	Low
Untyped Blob in createImageFromBuffer	MEDIUM	Correctness	Trivial
Default 1024×1024 in maskToArrayBuffer	LOW	API Design	Trivial
No .close() docs on crop/resize	LOW	Memory	Trivial
Incomplete CJK regex ranges	LOW	Correctness	Low


Rust-Side Text Rendering & Export System Analysis
1. How the Rust-Side Renderer Works
The pipeline is in src-tauri/src/commands/render.rs and src-tauri/src/text_renderer.rs:

Frontend sends a RenderRequest containing a base image (PNG buffer), text blocks, render method ("rectangle" / "lama" / "newlama"), and a default font name.
The base image is decoded via image::load_from_memory.
For "rectangle" mode, filled rectangles are drawn behind each text block using imageproc::draw_filled_rect_mut (rounded corners are a TODO — currently draws sharp rects at line 395).
Each text block is rendered character-by-character using ab_glyph + imageproc::draw_text_mut with a FontStack fallback system.
The result is PNG-encoded and returned as Vec<u8>.
2. Fonts
Font loading (text_renderer.rs lines 22–104):

Primary font: loaded from the system via font_kit::SystemSource matching the user-specified fontFamily.
Fallback stack: Tries 13 additional system fonts (Segoe UI Symbol, Segoe UI Emoji, Apple Symbols, Noto Sans Symbols, GoNotoCJKCore, Symbola, DejaVu Sans, etc.)
Embedded fallback fonts (compiled into the binary):
GoNotoCJKCore.ttf — CJK coverage
NotoSans-Regular.ttf — emergency last-resort
If user's font is not found, load_font_by_family silently falls back to NotoSans-Regular instead of propagating the error — this can produce unexpected results without clear user feedback.
3. Text Layout (Line Breaking & Sizing)
Word wrapping (lines 435–455):

Splits text by space characters only (text.split(' '))
Greedy line-fill: adds words until measured width exceeds box_width * 0.9 (10% padding)
Width is measured per-character using font_stack.font_for_char() + individual glyph h_advance
Vertical positioning (lines 458–465):

Lines are vertically centered within the bounding box
If total text height exceeds 90% of box height, text starts at ymin + lineHeight/2
Horizontal positioning:

Each line is horizontally centered by computing center_x - total_width / 2.0
4. Vertical Text Handling
Critical finding: The Rust renderer has NO vertical text (tategaki) support.

The frontend detects writing mode in writing-mode.ts using CJK character heuristics + aspect ratio, then renders CJK text in writing-mode: vertical-rl via CSS.
The SmartFitText component in smart-fit-text.tsx uses isVertical with a DiamondWrapper for preview.
None of this is replicated in Rust. The TextBlock struct doesn't even have a writingMode or isVertical field. All text is rendered horizontally left-to-right.
5. CJK Character Handling
The FontStack::font_for_char() method (lines 116–137) does per-character font fallback by checking if each font has an outline for the glyph — this is correct and works well for mixed scripts.
CJK characters will be found in GoNotoCJKCore or user system fonts.
Bug: Word wrapping splits on space only. CJK text typically has no spaces between characters, so an entire CJK paragraph becomes one "word" and will never wrap. It will overflow the bounding box.
6. Does the Output Match the Frontend Preview?
No — there are major discrepancies:

Feature	Frontend Preview	Rust Export
Text rendering engine	CSS/HTML DOM (SmartFitText) or Konva.js	ab_glyph + imageproc::draw_text_mut
Vertical text	CSS writing-mode: vertical-rl	Not supported — always horizontal
Font sizing	Binary search to fit text in diamond-shaped region	Fixed font size from state; no auto-fit
Word wrapping	Browser-native (word-break, hyphens: auto)	Space-split greedy only (breaks CJK)
Text outline	CSS text-shadow 8-point with configurable width	8-direction glyph re-draw at integer offsets
Rounded rectangles	Canvas quadraticCurveTo	Stub — draws sharp rectangles (TODO in code)
Diamond text region	DiamondWrapper clips text to diamond shape	No clipping — text fills full rectangle
Mix blend mode	mix-blend-mode: multiply	Not applied
Font weight/stretch	CSS properties applied	font_weight and font_stretch fields are deserialized but never used
Padding	isVertical ? '10% 5%' : '5% 10%'	Fixed 10% (0.9 multiplier on width only)
7. Bugs & Quality Issues
Critical Bugs
No CJK word wrapping — CJK text without spaces renders as a single unwrapped line that overflows the box. Fix: implement character-level wrapping for CJK codepoint ranges.

No vertical text — Japanese manga is overwhelmingly vertical. Exported images will show horizontally-rendered CJK text that doesn't match the preview at all.

font_weight / font_stretch ignored — These fields are deserialized from frontend but never passed to font selection. Properties::new() always uses default weight/stretch.

draw_unicode_debug_test called on every export (line 283) — This function is invoked unconditionally in production. Although the actual draw calls inside are commented out, the function still creates FontStack objects and loads fonts for debug testing, wasting resources.

Rounded rectangle is a TODO — Line 395: just draws draw_filled_rect_mut with sharp corners.

Quality Issues
Outline rendering is low quality — Uses 8 offsets at integer pixel positions. CSS text-shadow produces smooth anti-aliased outlines; the Rust approach produces jagged outlines, especially at larger stroke widths (each offset is outline_width pixels, not sub-pixel).

Y-coordinate is draw_text_mut top-edge, not baseline — The y coordinate passed is treated as top of glyph bounding box, but the vertical centering calculation assumes center-of-line. This likely causes slight vertical misalignment.

Duplicate RenderRequest definition — Defined both in commands.rs line 1383 and commands/render.rs line 8. Only one is used at runtime (whichever render_and_export_image is registered in lib.rs).

Font reloaded per text block — FontStack::from_font_family is called for each block (line 356), creating system font queries and loading font data repeatedly. Should be cached by font family.

No subpixel rendering — All positions are cast to i32 before drawing (current_x as i32, y as i32), losing subpixel precision.

8. Performance Characteristics
Concern	Detail
Font loading	font_kit::SystemSource is queried per block per export. For 20 blocks with the same font, fonts are loaded 20 times. The symbol font fallback loop also queries 13 system fonts per block.
Character-by-character rendering	Every character is drawn individually via draw_text_mut, which means per-glyph rasterization without batching. This is O(n × chars) where n = total characters.
Debug function overhead	draw_unicode_debug_test creates font stacks on every export even though all draw calls are commented out.
PNG encoding	Single-threaded image::write_to PNG encoding. For large images (3000×4000+), this can take 500ms+.
Memory	Base image is cloned to RGBA8 (base_image.to_rgba8()). The font data is also cloned from include_bytes! to Vec.
Estimated time	For a typical manga page (20 blocks, 500 chars total): ~200-500ms for text rendering + ~300-800ms for PNG encoding.
Recommendations (Priority Order)
Implement CJK character-level line wrapping — Add a check: if the character is in CJK ranges (U+3000–U+9FFF, U+F900–U+FAFF), wrap at character boundaries, not word boundaries.

Add vertical text rendering — Implement top-to-bottom, right-to-left column layout. Port the detectWritingMode heuristic from the frontend. Rotate glyphs or use vertical glyph metrics.

Use font_weight/font_stretch — Pass these to font_kit::Properties when querying system fonts.

Cache font stacks — Use a HashMap<String, FontStack> to avoid reloading the same font family for every text block.

Remove debug code from production — Gate draw_unicode_debug_test behind #[cfg(debug_assertions)] or remove entirely.

Remove duplicate RenderRequest — Keep only the one in commands/render.rs.

Consider switching to a higher-quality text engine — Libraries like cosmic-text or rustybuzz + swash handle shaping, kerning, BiDi, vertical text, and subpixel positioning natively. The current ab_glyph + character-by-character approach will never match browser-quality rendering.

Implement proper rounded rectangles — Use Bresenham circle arcs or a 2D drawing library like tiny-skia.


1. CSS Framework: Tailwind CSS v4
Uses the new Tailwind v4 import syntax: @import 'tailwindcss' (not the v3 @tailwind directives)
PostCSS configured with @tailwindcss/postcss plugin (v4 style)
No tailwind.config.ts — Tailwind v4 uses CSS-first configuration, so this is expected. Custom theme values would go directly in globals.css via @theme.
Version: ^4.1.12
2. Responsiveness
Partially responsive, but designed as a desktop app:

The main layout uses h-screen w-screen max-h-screen max-w-screen — it's a fixed full-viewport app, not a scrollable responsive page. This is appropriate for a Tauri desktop app.
Sidebar has dynamic resizing with pointer-drag, min/max width constraints (SIDEBAR_MIN_WIDTH = 200, SIDEBAR_MAX_WIDTH_RATIO = 0.5), and collapse support.
body { overflow: hidden } enforces no page scroll.
Touch device detection widens the resize handle (12px vs 4px), which is good accessibility.
No responsive breakpoints (sm:, md:, lg:) are used — the layout relies on flexbox and programmatic width management instead.
Verdict: Not responsive in a web sense, but appropriately adaptive for a desktop Tauri shell.

3. Dark Mode Support
Implemented but incomplete:

Dark mode toggling is JS-driven via document.documentElement.classList.toggle('dark', theme === 'dark') in page.tsx.
Many components use dark: variants correctly: dark:bg-gray-900, dark:border-gray-700, dark:text-gray-100, etc.
Issues found:
Scrollbar styles in globals.css are hardcoded light — #f8f8f8 track and #c0c0c0 thumb have no dark mode variants. These will look jarring in dark mode.
Splashscreen has no dark mode — splashscreen/page.tsx uses hardcoded bg-white with no dark:bg-* variant.
Radix Theme is not configured for dark mode — <Theme accentColor='ruby'> in layout.tsx has no appearance="dark" prop. Radix <Theme> defaults to light, so Radix components won't follow the Tailwind dark mode toggle.
No color-scheme meta tag or CSS property for native UI elements (scrollbars, form controls).
4. Overall Page Structure
<html>
  <body> (Noto Sans JP + SC, antialiased)
    <Theme accentColor="ruby">           ← Radix UI theme wrapper
      <main> (full screen, flex column)
        <Topbar />                       ← Top navigation bar
        <div> (flex row, flex-1)
          <Tools />                      ← Left toolbar (w-20, fixed)
          <div> (flex-1)
            <Canvas />                   ← Central canvas (Konva)
            <aside>                      ← Right sidebar (resizable)
              [resize handle]
              [collapse/expand button]
              [context-dependent panels]:
                - detection → DetectionPanel + OCRPanel
                - translation → TranslationPanel
                - inpaint → InpaintSettings + InpaintPanel
                - render → RenderPanel
            </aside>
          </div>
        </div>
      </main>
    </Theme>
  </body>
</html>
Classic editor layout: toolbar left, canvas center, properties panel right.

5. TypeScript Strictness
Lax — strict: false, noImplicitAny: false:

tsconfig.json has "strict": false and "noImplicitAny": false. This allows implicit any types everywhere and disables null checks, strict function types, etc.
Target is ES2017 — reasonable for Tauri's embedded WebView.
Path alias @/* → ./* is configured correctly.
Recommendation: Enabling strict: true would catch real bugs (null dereference, missing types), but it's a significant migration effort for an existing codebase.
6. CSS Issues
Issue	Severity	Location
Scrollbar styles not dark-mode aware	Medium	globals.css
Splashscreen hardcoded to light theme	Low	splashscreen/page.tsx
Radix <Theme> ignores dark mode	High	layout.tsx
No @theme customization in CSS	Info	globals.css — no custom colors/spacing defined
Sidebar bg uses bg-white/95 (translucent) — may cause visual artifacts if canvas renders underneath	Low	page.tsx
Inline transition styles on sidebar could be CSS classes for consistency	Low	page.tsx
7. Splashscreen Implementation
splashscreen/page.tsx is minimal:

Simple centered "Koharu" heading + "Initializing..." text
Uses brand color #E0115F (ruby/crimson) directly
No animation, no loading indicator, no dark mode
Likely shown by Tauri's splashscreen window during app initialization, then swapped to the main window
8. UI Dependencies
Package	Purpose	Version
@radix-ui/themes	Component library (buttons, dialogs, etc.)	^3.2.1
lucide-react	Icon library	^0.525.0
konva + react-konva	Canvas rendering engine	^9.3.22 / ^19.0.7
zustand	State management	^5.0.7
browser-fs-access	File system access (open/save dialogs)	^0.38.0
@tauri-apps/api	Tauri IPC bridge	^2.7.0
tailwindcss	Utility CSS framework	^4.1.12
Notable: Using Radix Themes (pre-built components), not Radix Primitives (headless). This means Radix handles its own styling, which creates a dual styling system (Radix theme + Tailwind utilities) that needs coordination — especially for dark mode, where Radix expects its own appearance prop.

Summary of Key Findings
Critical: Radix <Theme> doesn't sync with Tailwind dark mode. Fix by passing appearance={theme} from state, or using Radix's built-in dark mode detection.
Medium: Scrollbar CSS needs dark mode variants using @media (prefers-color-scheme: dark) or Tailwind's dark: via the @theme layer.
Low: TypeScript strictness is off — acceptable for rapid prototyping but a liability long-term.
Good: Sidebar resize/collapse UX is well-implemented with touch support, keyboard shortcut (Ctrl+B), accessibility attributes, and smooth transitions.
Good: Clean separation — state in Zustand, rendering in Konva, UI in Radix+Tailwind, backend bridge via Tauri invoke.







