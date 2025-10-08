use anyhow::{Context, anyhow};
use tauri::{AppHandle, Manager};
use font_kit::source::SystemSource;
use image::GenericImageView;
use std::fs;
use reqwest;
use serde::{Deserialize, Serialize};

use crate::{AppState, error::CommandResult};
use crate::text_renderer::{render_text_on_image, TextBlock};

#[tauri::command]
pub async fn detection(
    app: AppHandle,
    image: Vec<u8>,
    confidence_threshold: f32,
    nms_threshold: f32,
) -> CommandResult<comic_text_detector::Output> {
    let state = app.state::<AppState>();

    let img = image::load_from_memory(&image).context("Failed to load image")?;

    let result = state
        .comic_text_detector
        .lock()
        .await
        .inference(&img, confidence_threshold, nms_threshold)
        .context("Failed to perform inference")?;

    Ok(result)
}

#[tauri::command]
pub async fn ocr(app: AppHandle, image: Vec<u8>) -> CommandResult<Vec<String>> {
    let state = app.state::<AppState>();
    let active_key = state.active_ocr.read().await.clone();
    let pipelines = state.ocr_pipelines.read().await;
    
    if let Some(pipeline) = pipelines.get(&active_key) {
        let img = image::load_from_memory(&image).context("Failed to load image")?;
        let regions = pipeline.detect_text_regions(&img).await?;
        let result = pipeline.recognize_text(&img, &regions).await?;
        Ok(result)
    } else {
        Err(anyhow!("OCR engine not found: {}", active_key).into())
    }
}

#[tauri::command]
pub async fn set_active_ocr(app: AppHandle, model_key: String) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let pipelines = state.ocr_pipelines.read().await;
    
    if !pipelines.contains_key(&model_key) {
        return Err(anyhow!("OCR model not found: {}", model_key).into());
    }
    
    *state.active_ocr.write().await = model_key;
    Ok(())
}

/// DEPRECATED: Full-image inpainting - replaced by inpaint_region with per-block processing
/// This function produces suboptimal results (white fills) and should not be used.
/// Use inpaint_region instead for proper cropping, erosion, and mask handling.
#[tauri::command]
#[deprecated(note = "Use inpaint_region instead - this produces white artifacts")]
pub async fn inpaint(app: AppHandle, image: Vec<u8>, mask: Vec<u8>) -> CommandResult<Vec<u8>> {
    let state = app.state::<AppState>();

    let img = image::load_from_memory(&image).context("Failed to load image")?;
    let mask_img = image::load_from_memory(&mask).context("Failed to load mask")?;

    let result = state
        .lama
        .lock()
        .await
        .inference(&img, &mask_img)
        .context("Failed to perform inpainting")?;

    // Encode result as PNG so frontend can decode it
    let mut png_bytes = Vec::new();
    result
        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .context("Failed to encode inpainted image as PNG")?;

    Ok(png_bytes)
}

#[tauri::command]
pub fn get_system_fonts() -> CommandResult<Vec<String>> {
    let source = SystemSource::new();
    let mut fonts = source
        .all_families()
        .context("Failed to enumerate system fonts")?;

    // Sort alphabetically for better UX
    fonts.sort();

    Ok(fonts)
}

#[derive(serde::Deserialize)]
pub struct BBox {
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintConfig {
    pub padding: i32,              // Context padding (15-100px)
    pub target_size: u32,          // Inference resolution (256/384/512/768/1024)
    pub mask_threshold: u8,        // Binary threshold (20-50)
    pub mask_erosion: u32,         // Erosion radius (0-10px)
    pub mask_dilation: u32,        // Optional dilation before erosion (0-5px)
    pub feather_radius: u32,       // Alpha compositing feather (used by frontend)
    pub debug_mode: bool,          // Export triptychs
}

impl Default for InpaintConfig {
    fn default() -> Self {
        InpaintConfig {
            padding: 50,
            target_size: 512,
            mask_threshold: 30,
            mask_erosion: 3,
            mask_dilation: 0,
            feather_radius: 5,
            debug_mode: false,
        }
    }
}

#[derive(serde::Serialize)]
pub struct InpaintedRegion {
    pub image: Vec<u8>,
    pub x: f32,
    pub y: f32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn inpaint_region(
    app: AppHandle,
    image: Vec<u8>,
    mask: Vec<u8>,
    bbox: BBox,
    padding: Option<i32>,       // DEPRECATED: Use config.padding instead
    debug_mode: Option<bool>,   // DEPRECATED: Use config.debug_mode instead
    config: Option<InpaintConfig>, // NEW: Full configuration
) -> CommandResult<InpaintedRegion> {
    let state = app.state::<AppState>();

    // Use config if provided, otherwise fall back to legacy parameters for backward compat
    let cfg = config.unwrap_or_else(|| InpaintConfig {
        padding: padding.unwrap_or(50),
        debug_mode: debug_mode.unwrap_or(false),
        ..Default::default()
    });

    tracing::info!("inpaint_region called with config: {:?}", cfg);

    // Load images
    let full_image = image::load_from_memory(&image).context("Failed to load image")?;
    let full_mask_img = image::load_from_memory(&mask).context("Failed to load mask")?;
    let full_mask = full_mask_img.to_luma8();

    let (orig_width, orig_height) = full_image.dimensions();

    // Log original dimensions and config
    tracing::debug!(
        "inpaint_region: orig={}x{}, mask={}x{}, bbox=[{},{} -> {},{}], config={:?}",
        orig_width, orig_height,
        full_mask.width(), full_mask.height(),
        bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax,
        cfg
    );

    // Add padding for context (using config)
    let padded_bbox = BBox {
        xmin: (bbox.xmin - cfg.padding as f32).max(0.0),
        ymin: (bbox.ymin - cfg.padding as f32).max(0.0),
        xmax: (bbox.xmax + cfg.padding as f32).min(orig_width as f32),
        ymax: (bbox.ymax + cfg.padding as f32).min(orig_height as f32),
    };
    
    // Assert valid bbox
    if !(padded_bbox.xmax > padded_bbox.xmin && padded_bbox.ymax > padded_bbox.ymin) {
        return Err(anyhow::anyhow!(
            "Invalid padded bbox: [{},{} -> {},{}]",
            padded_bbox.xmin, padded_bbox.ymin, padded_bbox.xmax, padded_bbox.ymax
        ).into());
    }

    // Crop image region
    let crop_width = (padded_bbox.xmax - padded_bbox.xmin) as u32;
    let crop_height = (padded_bbox.ymax - padded_bbox.ymin) as u32;
    
    tracing::debug!(
        "Padded bbox: [{},{} -> {},{}] = {}x{}px",
        padded_bbox.xmin, padded_bbox.ymin, padded_bbox.xmax, padded_bbox.ymax,
        crop_width, crop_height
    );

    let cropped_image = full_image.crop_imm(
        padded_bbox.xmin as u32,
        padded_bbox.ymin as u32,
        crop_width,
        crop_height,
    );

    // Extract and resize mask to match crop (with config)
    let cropped_mask = extract_and_resize_mask(
        &full_mask,
        &padded_bbox,
        orig_width,
        orig_height,
        crop_width,
        crop_height,
        &cfg,
    )?;

    // Debug: Save triptych if debug mode enabled
    if cfg.debug_mode {
        save_debug_triptych(
            &app,
            &cropped_image,
            &cropped_mask,
            &bbox,
            &padded_bbox,
        )?;
    }

    // Run LaMa inference with configurable target size (convert GrayImage to DynamicImage)
    let mask_dynamic = image::DynamicImage::ImageLuma8(cropped_mask.clone());

    tracing::info!("Running LaMa inference with target_size={}", cfg.target_size);

    let inpainted_crop = state
        .lama
        .lock()
        .await
        .inference_with_size(&cropped_image, &mask_dynamic, cfg.target_size)
        .context("Failed to perform inpainting")?;

    tracing::info!("LaMa inference completed successfully");

    // Debug: Save triptych output if debug mode enabled
    if cfg.debug_mode {
        save_debug_output(
            &app,
            &cropped_image,
            &cropped_mask,
            &inpainted_crop,
            &bbox,
        )?;
    }

    // Encode as PNG
    let mut png_bytes = Vec::new();
    inpainted_crop
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .context("Failed to encode PNG")?;

    Ok(InpaintedRegion {
        image: png_bytes,
        x: padded_bbox.xmin,
        y: padded_bbox.ymin,
        width: crop_width,
        height: crop_height,
    })
}

fn extract_and_resize_mask(
    full_mask: &image::GrayImage,
    bbox: &BBox,
    orig_width: u32,
    orig_height: u32,
    target_width: u32,
    target_height: u32,
    config: &InpaintConfig,
) -> anyhow::Result<image::GrayImage> {
    // Scale factors: original → 1024×1024 mask (assuming mask is 1024x1024)
    let mask_width = full_mask.width();
    let mask_height = full_mask.height();
    let scale_x = mask_width as f32 / orig_width as f32;
    let scale_y = mask_height as f32 / orig_height as f32;

    // Map bbox to mask coordinates using consistent floor/ceil
    let mask_xmin = (bbox.xmin * scale_x).floor().max(0.0) as u32;
    let mask_ymin = (bbox.ymin * scale_y).floor().max(0.0) as u32;
    let mask_xmax = (bbox.xmax * scale_x).ceil().min(mask_width as f32) as u32;
    let mask_ymax = (bbox.ymax * scale_y).ceil().min(mask_height as f32) as u32;

    let mask_crop_width = mask_xmax.saturating_sub(mask_xmin);
    let mask_crop_height = mask_ymax.saturating_sub(mask_ymin);
    
    tracing::debug!(
        "Mask extraction: scale=({:.3},{:.3}), mask_bbox=[{},{} -> {},{}], crop={}x{}",
        scale_x, scale_y,
        mask_xmin, mask_ymin, mask_xmax, mask_ymax,
        mask_crop_width, mask_crop_height
    );
    
    if mask_crop_width == 0 || mask_crop_height == 0 {
        return Err(anyhow::anyhow!(
            "Invalid mask crop dimensions: {}x{}",
            mask_crop_width, mask_crop_height
        ));
    }

    // Crop mask with bounds checking
    let mut cropped_mask = image::GrayImage::new(mask_crop_width, mask_crop_height);
    for y in 0..mask_crop_height {
        for x in 0..mask_crop_width {
            let px = (mask_xmin + x).min(mask_width - 1);
            let py = (mask_ymin + y).min(mask_height - 1);
            let pixel = full_mask.get_pixel(px, py);
            cropped_mask.put_pixel(x, y, *pixel);
        }
    }

    // Apply threshold to binarize mask (configurable)
    let mut thresholded = cropped_mask.clone();
    for pixel in thresholded.pixels_mut() {
        if pixel[0] < config.mask_threshold {
            pixel[0] = 0;
        }
    }

    // Optional dilation (fills gaps in text strokes)
    let mut morphed = thresholded;
    if config.mask_dilation > 0 {
        morphed = dilate_mask(&morphed, config.mask_dilation);
        tracing::debug!("Applied {}px mask dilation", config.mask_dilation);
    }

    // Resize to match image crop using NEAREST for masks (CRITICAL: no interpolation)
    let mut resized_mask = image::imageops::resize(
        &morphed,
        target_width,
        target_height,
        image::imageops::FilterType::Nearest,
    );

    // Apply erosion to pull mask away from edges (configurable)
    if config.mask_erosion > 0 {
        resized_mask = erode_mask(&resized_mask, config.mask_erosion);
        tracing::debug!("Applied {}px mask erosion", config.mask_erosion);
    }
    
    tracing::debug!(
        "Mask resized: {}x{} -> {}x{} (nearest-neighbor, threshold={}, erosion={}px, dilation={}px)",
        mask_crop_width, mask_crop_height,
        target_width, target_height,
        config.mask_threshold,
        config.mask_erosion,
        config.mask_dilation
    );

    Ok(resized_mask)
}

/// Simple dilation: expand white regions by kernel_size pixels
fn dilate_mask(mask: &image::GrayImage, kernel_size: u32) -> image::GrayImage {
    use imageproc::morphology::dilate;
    use imageproc::distance_transform::Norm;

    dilate(mask, Norm::LInf, kernel_size as u8)
}

/// Simple erosion: shrink white regions by kernel_size pixels
fn erode_mask(mask: &image::GrayImage, kernel_size: u32) -> image::GrayImage {
    use imageproc::morphology::dilate_mut;
    use imageproc::distance_transform::Norm;
    
    let mut result = mask.clone();
    
    // Invert (so white becomes black), dilate (grows black), invert back (shrinks white)
    for pixel in result.pixels_mut() {
        pixel[0] = 255 - pixel[0];
    }
    
    dilate_mut(&mut result, Norm::LInf, kernel_size as u8);
    
    for pixel in result.pixels_mut() {
        pixel[0] = 255 - pixel[0];
    }
    
    result
}

/// Save debug triptych: original crop, mask, and red overlay
fn save_debug_triptych(
    app: &AppHandle,
    crop: &image::DynamicImage,
    mask: &image::GrayImage,
    bbox: &BBox,
    _padded_bbox: &BBox,
) -> anyhow::Result<()> {
    let debug_dir = app.path().app_cache_dir()
        .context("Failed to get cache dir")?
        .join("inpaint_debug");
    
    fs::create_dir_all(&debug_dir)?;
    
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    
    let bbox_str = format!("{:.0}_{:.0}", bbox.xmin, bbox.ymin);
    
    // Save crop
    crop.save(debug_dir.join(format!("{}_{}_crop.png", timestamp, bbox_str)))?;
    
    // Save mask
    image::DynamicImage::ImageLuma8(mask.clone())
        .save(debug_dir.join(format!("{}_{}_mask.png", timestamp, bbox_str)))?;
    
    // Create red overlay
    let mut overlay = crop.to_rgb8();
    for y in 0..mask.height() {
        for x in 0..mask.width() {
            if mask.get_pixel(x, y)[0] > 128 {
                // Red overlay on white mask regions
                overlay.put_pixel(x, y, image::Rgb([255, 0, 0]));
            }
        }
    }
    image::DynamicImage::ImageRgb8(overlay)
        .save(debug_dir.join(format!("{}_{}_overlay.png", timestamp, bbox_str)))?;
    
    tracing::info!("Saved debug triptych to {:?}", debug_dir);
    Ok(())
}

/// Save debug output after inpainting
fn save_debug_output(
    app: &AppHandle,
    crop: &image::DynamicImage,
    mask: &image::GrayImage,
    output: &image::DynamicImage,
    bbox: &BBox,
) -> anyhow::Result<()> {
    let debug_dir = app.path().app_cache_dir()
        .context("Failed to get cache dir")?
        .join("inpaint_debug");
    
    fs::create_dir_all(&debug_dir)?;
    
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    
    let bbox_str = format!("{:.0}_{:.0}", bbox.xmin, bbox.ymin);
    
    // Create side-by-side triptych
    let w = crop.width();
    let h = crop.height();
    let mut triptych = image::RgbImage::new(w * 3, h);
    
    // Panel 1: Original crop
    let crop_rgb = crop.to_rgb8();
    for y in 0..h {
        for x in 0..w {
            triptych.put_pixel(x, y, *crop_rgb.get_pixel(x, y));
        }
    }
    
    // Panel 2: Mask (white = hole to fill)
    for y in 0..h {
        for x in 0..w {
            let v = mask.get_pixel(x, y)[0];
            triptych.put_pixel(w + x, y, image::Rgb([v, v, v]));
        }
    }
    
    // Panel 3: LaMa output
    let output_rgb = output.to_rgb8();
    for y in 0..h {
        for x in 0..w {
            triptych.put_pixel(w * 2 + x, y, *output_rgb.get_pixel(x, y));
        }
    }
    
    image::DynamicImage::ImageRgb8(triptych)
        .save(debug_dir.join(format!("{}_{}_triptych.png", timestamp, bbox_str)))?;
    
    tracing::info!("Saved inpaint triptych to {:?}", debug_dir);
    Ok(())
}

#[tauri::command]
pub fn set_gpu_preference(app: AppHandle, preference: String) -> CommandResult<()> {
    let app_dir = app.path().app_config_dir()
        .context("Failed to get app config directory")?;

    fs::create_dir_all(&app_dir)
        .context("Failed to create app config directory")?;

    let config_path = app_dir.join("gpu_preference.txt");

    fs::write(&config_path, preference.trim())
        .context("Failed to write GPU preference")?;

    tracing::info!("GPU preference saved. Restart required to take effect.");

    Ok(())
}

#[derive(serde::Serialize)]
pub struct GpuDevice {
    pub device_id: u32,
    pub name: String,
    pub vendor: String,
    pub backend: String,
}

#[tauri::command]
pub fn get_gpu_devices() -> CommandResult<Vec<GpuDevice>> {
    use wgpu::{Instance, InstanceDescriptor, Backends};

    let instance = Instance::new(InstanceDescriptor {
        backends: Backends::all(),
        ..Default::default()
    });

    let adapters = instance.enumerate_adapters(Backends::all());
    let mut devices = Vec::new();

    for (idx, adapter) in adapters.iter().enumerate() {
        let info = adapter.get_info();
        devices.push(GpuDevice {
            device_id: idx as u32,
            name: info.name.clone(),
            vendor: match info.vendor {
                0x10DE => "NVIDIA".to_string(),
                0x1002 | 0x1022 => "AMD".to_string(),
                0x8086 => "Intel".to_string(),
                _ => format!("Unknown (0x{:04X})", info.vendor),
            },
            backend: format!("{:?}", info.backend),
        });
    }

    Ok(devices)
}

#[tauri::command]
pub fn get_current_gpu_status(app: AppHandle) -> CommandResult<crate::state::GpuInitResult> {
    let state = app.state::<AppState>();
    let init_result = state.gpu_init_result.blocking_lock();
    Ok(init_result.clone())
}

#[derive(serde::Serialize)]
pub struct StressTestResult {
    pub timings_ms: Vec<u64>,
    pub avg_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub target_size: u32,
    pub iterations: usize,
}

#[tauri::command]
pub async fn run_gpu_stress_test(
    app: AppHandle,
    iterations: Option<usize>,
    target_size: Option<u32>,
) -> CommandResult<StressTestResult> {
    let state = app.state::<AppState>();
    let iterations = iterations.unwrap_or(5);
    let target_size = target_size.unwrap_or(768);

    tracing::info!("Running GPU stress test: {} iterations at {}x{}", iterations, target_size, target_size);

    let mut timings = Vec::new();

    for i in 0..iterations {
        let start = std::time::Instant::now();

        // Create test images (512px hardcoded for consistent benchmark)
        let test_image = image::DynamicImage::new_rgb8(512, 512);
        let test_mask = image::DynamicImage::new_luma8(512, 512);

        // Run LaMa inference (uses legacy 512px inference for compatibility)
        state.lama.lock().await.inference(&test_image, &test_mask)
            .context(format!("Stress test iteration {} failed", i + 1))?;

        let elapsed = start.elapsed().as_millis() as u64;
        timings.push(elapsed);

        tracing::debug!("Stress test iteration {}/{}: {}ms", i + 1, iterations, elapsed);
    }

    let avg = timings.iter().sum::<u64>() / timings.len() as u64;
    let min = *timings.iter().min().unwrap();
    let max = *timings.iter().max().unwrap();

    tracing::info!(
        "Stress test complete: avg={}ms, min={}ms, max={}ms",
        avg, min, max
    );

    Ok(StressTestResult {
        timings_ms: timings,
        avg_ms: avg,
        min_ms: min,
        max_ms: max,
        target_size,
        iterations,
    })
}

// DeepL Translation API types and command
#[derive(Debug, Serialize, Deserialize)]
struct DeepLRequest {
    text: Vec<String>,
    target_lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_lang: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeepLTranslation {
    detected_source_language: Option<String>,
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct DeepLResponse {
    translations: Vec<DeepLTranslation>,
}

#[tauri::command]
pub async fn translate_with_deepl(
    api_key: String,
    text: String,
    use_pro: bool,
    source_lang: Option<String>,
    target_lang: Option<String>,
) -> CommandResult<String> {
    let base_url = if use_pro {
        "https://api.deepl.com"
    } else {
        "https://api-free.deepl.com"
    };

    let url = format!("{}/v2/translate", base_url);

    // Default to EN-US as recommended by DeepL docs
    let target = target_lang.unwrap_or_else(|| "EN-US".to_string()).to_uppercase();

    let request_body = DeepLRequest {
        text: vec![text],
        target_lang: target,
        source_lang: source_lang.map(|s| s.to_uppercase()),
    };

    tracing::debug!("DeepL request: endpoint={}, use_pro={}, body={:?}", url, use_pro, request_body);

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {}", api_key))
        .header("User-Agent", "Koharu/1.0")
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .context("Failed to send DeepL API request")?;

    let status = response.status();

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());

        // Handle specific error codes
        let error_msg = match status.as_u16() {
            401 | 403 => "Invalid API key or insufficient permissions".to_string(),
            429 => "Rate limit exceeded. Please wait and try again.".to_string(),
            456 => "Quota exceeded. For DeepL Free, you've used your 500,000 character/month limit.".to_string(),
            _ => format!("DeepL API error ({}): {}", status.as_u16(), error_text),
        };

        return Err(anyhow::anyhow!(error_msg).into());
    }

    let deepl_response: DeepLResponse = response
        .json()
        .await
        .context("Failed to parse DeepL API response")?;

    deepl_response
        .translations
        .first()
        .map(|t| t.text.clone())
        .ok_or_else(|| anyhow::anyhow!("DeepL returned no translations").into())
}

// Ollama Translation API types and command
#[derive(Debug, Serialize, Deserialize)]
struct OllamaChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaChatMessage>,
    stream: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaChatResponse {
    message: OllamaChatMessage,
}

#[tauri::command]
pub async fn translate_with_ollama(
    text: String,
    model: String,
    system_prompt: Option<String>,
) -> CommandResult<String> {
    let url = "http://localhost:11434/api/chat";

    // Build messages array
    let mut messages = Vec::new();

    // Add system prompt if provided
    if let Some(prompt) = system_prompt {
        if !prompt.trim().is_empty() {
            messages.push(OllamaChatMessage {
                role: "system".to_string(),
                content: prompt,
            });
        }
    }

    // Add user message with the OCR'd text
    messages.push(OllamaChatMessage {
        role: "user".to_string(),
        content: text,
    });

    let request_body = OllamaChatRequest {
        model,
        messages,
        stream: false,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .context("Failed to connect to Ollama. Make sure Ollama is running on http://localhost:11434")?;

    let status = response.status();

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        let error_msg = format!("Ollama API error ({}): {}", status.as_u16(), error_text);
        return Err(anyhow::anyhow!(error_msg).into());
    }

    let ollama_response: OllamaChatResponse = response
        .json()
        .await
        .context("Failed to parse Ollama API response")?;

    Ok(ollama_response.message.content)
}

// ============================================================================
// Image Rendering and Export Commands
// ============================================================================

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub base_image_buffer: Vec<u8>,
    pub text_blocks: Vec<TextBlock>,
    pub render_method: String,
    pub default_font: String,
}

#[tauri::command]
pub async fn render_and_export_image(
    request: RenderRequest,
) -> CommandResult<Vec<u8>> {
    tracing::info!(
        "[RUST_EXPORT] Starting render with method='{}', {} text blocks",
        request.render_method,
        request.text_blocks.len()
    );
    
    // Validate render method
    if request.render_method != "rectangle" 
        && request.render_method != "lama" 
        && request.render_method != "newlama" 
    {
        return Err(anyhow::anyhow!("Invalid render method: {}", request.render_method).into());
    }
    
    // Load base image from buffer
    let base_image = image::load_from_memory(&request.base_image_buffer)
        .context("Failed to load base image")?;
    
    tracing::info!(
        "[RUST_EXPORT] Base image loaded: {}x{}",
        base_image.width(),
        base_image.height()
    );
    
    // Render text on image (fonts loaded dynamically per text block)
    let rendered_image = render_text_on_image(
        base_image,
        request.text_blocks,
        &request.render_method,
        &request.default_font,
    )
    .context("Rendering failed")?;
    
    // Convert to PNG buffer
    let mut png_buffer = Vec::new();
    rendered_image
        .write_to(
            &mut std::io::Cursor::new(&mut png_buffer),
            image::ImageFormat::Png
        )
        .context("Failed to encode PNG")?;
    
    tracing::info!("[RUST_EXPORT] Export complete, PNG size: {} bytes", png_buffer.len());
    
    Ok(png_buffer)
}
