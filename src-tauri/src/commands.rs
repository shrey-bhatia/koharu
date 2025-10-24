use anyhow::{Context, anyhow};
use font_kit::source::SystemSource;
use image::{DynamicImage, GenericImageView, GrayImage};
use reqwest;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Manager};

use crate::ocr_pipeline::{MANGA_OCR_KEY, OcrPipeline};
use crate::text_renderer::{TextBlock, render_text_on_image};
use crate::{AppState, error::CommandResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub bboxes: Vec<comic_text_detector::ClassifiedBbox>,
    pub mask_png: Vec<u8>,
    pub mask_width: u32,
    pub mask_height: u32,
}

#[derive(Serialize)]
struct OcrRunResult {
    texts: Vec<String>,
    engine: String,
    region_count: usize,
}

async fn execute_ocr_pipeline(
    pipeline: Arc<dyn OcrPipeline + Send + Sync>,
    key: &str,
    image: &DynamicImage,
    payload_bytes: usize,
) -> anyhow::Result<OcrRunResult> {
    let detect_start = Instant::now();
    let regions = pipeline.detect_text_regions(image).await?;
    let detect_elapsed = detect_start.elapsed();
    tracing::info!(
        "[ocr:{}] detect_text_regions took {}ms ({} region(s), payload={} bytes)",
        key,
        detect_elapsed.as_millis(),
        regions.len(),
        payload_bytes
    );

    let recognize_start = Instant::now();
    let recognized = pipeline.recognize_text(image, &regions).await?;
    let recognize_elapsed = recognize_start.elapsed();
    tracing::info!(
        "[ocr:{}] recognize_text took {}ms",
        key,
        recognize_elapsed.as_millis()
    );

    Ok(OcrRunResult {
        texts: recognized,
        engine: key.to_string(),
        region_count: regions.len(),
    })
}

async fn run_ocr_with_pipelines(
    state: &AppState,
    active_key: &str,
    image: &DynamicImage,
    payload_bytes: usize,
) -> anyhow::Result<OcrRunResult> {
    let pipeline = {
        let guard = state.ocr_pipelines.read().await;
        guard.get(active_key).cloned()
    };

    let pipeline = match pipeline {
        Some(p) => p,
        None => {
            let available: Vec<String> = {
                let guard = state.ocr_pipelines.read().await;
                guard.keys().cloned().collect()
            };
            return Err(anyhow!(
                "OCR pipeline '{}' not found. Available engines: {:?}",
                active_key,
                available
            ));
        }
    };

    match execute_ocr_pipeline(pipeline, active_key, image, payload_bytes).await {
        Ok(result) => Ok(result),
        Err(err) => {
            tracing::warn!("OCR pipeline '{}' failed: {}", active_key, err);

            if active_key != MANGA_OCR_KEY {
                if let Some(fallback) = {
                    let guard = state.ocr_pipelines.read().await;
                    guard.get(MANGA_OCR_KEY).cloned()
                } {
                    tracing::warn!("Falling back to '{}' pipeline", MANGA_OCR_KEY);
                    execute_ocr_pipeline(fallback, MANGA_OCR_KEY, image, payload_bytes).await
                } else {
                    Err(err)
                }
            } else {
                Err(err)
            }
        }
    }
}

#[tauri::command]
pub async fn detection(
    app: AppHandle,
    image: Vec<u8>,
    confidence_threshold: f32,
    nms_threshold: f32,
) -> CommandResult<DetectionResult> {
    let state = app.state::<AppState>();

    let total_start = Instant::now();
    let decode_start = Instant::now();
    let img = image::load_from_memory(&image).context("Failed to load image")?;
    let decode_elapsed = decode_start.elapsed();
    tracing::info!(
        "[detection] image decode took {}ms",
        decode_elapsed.as_millis()
    );

    let inference_start = Instant::now();
    let output = state
        .comic_text_detector
        .lock()
        .await
        .inference(&img, confidence_threshold, nms_threshold)
        .context("Failed to perform inference")?;
    let inference_elapsed = inference_start.elapsed();
    tracing::info!(
        "[detection] model inference took {}ms",
        inference_elapsed.as_millis()
    );

    let comic_text_detector::Output {
        bboxes,
        segment,
        mask_width,
        mask_height,
    } = output;

    let encode_start = Instant::now();
    let mask_image = image::GrayImage::from_vec(mask_width, mask_height, segment)
        .context("Failed to reconstruct segmentation mask")?;
    let mut mask_dynamic = image::DynamicImage::ImageLuma8(mask_image);
    let mut mask_png = Vec::new();
    mask_dynamic
        .write_to(&mut Cursor::new(&mut mask_png), image::ImageFormat::Png)
        .context("Failed to encode segmentation mask as PNG")?;
    let encode_elapsed = encode_start.elapsed();
    tracing::info!(
        "[detection] mask PNG encode took {}ms ({} bytes)",
        encode_elapsed.as_millis(),
        mask_png.len()
    );

    tracing::info!(
        "[detection] total command time {}ms",
        total_start.elapsed().as_millis()
    );

    Ok(DetectionResult {
        bboxes,
        mask_png,
        mask_width,
        mask_height,
    })
}

#[tauri::command]
pub async fn ocr(app: AppHandle, image: Vec<u8>) -> CommandResult<Vec<String>> {
    let state = app.state::<AppState>();
    let command_start = Instant::now();
    let payload_bytes = image.len();

    let decode_start = Instant::now();
    let img = image::load_from_memory(&image).context("Failed to load image")?;
    let decode_elapsed = decode_start.elapsed();
    tracing::info!(
        "[ocr] image decode took {}ms ({} bytes, source=frontend)",
        decode_elapsed.as_millis(),
        payload_bytes
    );

    let active_key = state.active_ocr.read().await.clone();
    let run_result = run_ocr_with_pipelines(&state, &active_key, &img, payload_bytes).await?;

    tracing::info!(
        "[ocr] total command time {}ms (engine={}, regions={}, payload={} bytes, source=frontend)",
        command_start.elapsed().as_millis(),
        run_result.engine,
        run_result.region_count,
        payload_bytes
    );

    Ok(run_result.texts)
}

#[tauri::command]
pub async fn cache_ocr_image(app: AppHandle, image_png: Vec<u8>) -> CommandResult<()> {
    let state = app.state::<AppState>();

    let decode_start = Instant::now();
    let decoded =
        image::load_from_memory(&image_png).context("Failed to decode cached OCR image")?;
    let decode_elapsed = decode_start.elapsed();
    let (width, height) = decoded.dimensions();

    {
        let mut cache = state.ocr_image_cache.write().await;
        *cache = Some(Arc::new(decoded));
    }

    tracing::info!(
        "[ocr-cache] primed image cache in {}ms ({} bytes, dimensions={}x{})",
        decode_elapsed.as_millis(),
        image_png.len(),
        width,
        height
    );

    Ok(())
}

#[tauri::command]
pub async fn clear_ocr_cache(app: AppHandle) -> CommandResult<()> {
    let state = app.state::<AppState>();

    let mut cache = state.ocr_image_cache.write().await;
    if cache.is_some() {
        *cache = None;
        tracing::info!("[ocr-cache] cleared image cache");
    } else {
        tracing::debug!("[ocr-cache] clear requested but cache already empty");
    }

    Ok(())
}

#[tauri::command]
pub async fn ocr_cached_block(app: AppHandle, bbox: BBox) -> CommandResult<Vec<String>> {
    let state = app.state::<AppState>();
    let command_start = Instant::now();

    let image_arc = {
        let guard = state.ocr_image_cache.read().await;
        guard
            .clone()
            .ok_or_else(|| anyhow!("No cached OCR image. Call cache_ocr_image first."))?
    };

    let (image_width, image_height) = image_arc.dimensions();

    let crop_start = Instant::now();
    let xmin_f = bbox.xmin.floor().max(0.0);
    let ymin_f = bbox.ymin.floor().max(0.0);
    let xmax_f = bbox.xmax.ceil().min(image_width as f32);
    let ymax_f = bbox.ymax.ceil().min(image_height as f32);

    if xmax_f <= xmin_f || ymax_f <= ymin_f {
        return Err(anyhow!(
            "Invalid bounding box after clamping: [{:.2},{:.2}->{:.2},{:.2}]",
            xmin_f,
            ymin_f,
            xmax_f,
            ymax_f
        )
        .into());
    }

    let mut width = (xmax_f - xmin_f).ceil().max(1.0) as u32;
    let mut height = (ymax_f - ymin_f).ceil().max(1.0) as u32;

    let xmin = xmin_f as u32;
    let ymin = ymin_f as u32;

    if xmin >= image_width || ymin >= image_height {
        return Err(anyhow!(
            "Bounding box origin outside image bounds after clamping: ({}, {}) >= ({} ,{})",
            xmin,
            ymin,
            image_width,
            image_height
        )
        .into());
    }

    let max_width = image_width - xmin;
    let max_height = image_height - ymin;

    if max_width == 0 || max_height == 0 {
        return Err(anyhow!("Bounding box collapses to zero area after clamping").into());
    }

    if width > max_width {
        width = max_width;
    }
    if height > max_height {
        height = max_height;
    }

    if width == 0 || height == 0 {
        return Err(anyhow!("Computed crop dimensions are zero after clamping").into());
    }

    let cropped = image_arc.crop_imm(xmin, ymin, width, height);
    let crop_elapsed = crop_start.elapsed();

    let payload_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .unwrap_or(0);

    tracing::info!(
        "[ocr-cache] cropped bbox [{:.1},{:.1}->{:.1},{:.1}] -> {}x{}px in {}ms",
        bbox.xmin,
        bbox.ymin,
        bbox.xmax,
        bbox.ymax,
        width,
        height,
        crop_elapsed.as_millis()
    );

    let active_key = state.active_ocr.read().await.clone();
    let run_result = run_ocr_with_pipelines(&state, &active_key, &cropped, payload_bytes).await?;

    tracing::info!(
        "[ocr] total command time {}ms (engine={}, regions={}, payload={} bytes, source=cache)",
        command_start.elapsed().as_millis(),
        run_result.engine,
        run_result.region_count,
        payload_bytes
    );

    Ok(run_result.texts)
}

#[tauri::command]
pub async fn set_active_ocr(app: AppHandle, model_key: String) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let pipelines = state.ocr_pipelines.read().await;

    if !pipelines.contains_key(&model_key) {
        let available: Vec<String> = pipelines.keys().cloned().collect();
        return Err(anyhow!(
            "OCR model '{}' not found. Available engines: {:?}",
            model_key,
            available
        )
        .into());
    }

    drop(pipelines);

    *state.active_ocr.write().await = model_key.clone();
    tracing::info!("Switched active OCR engine to '{}'", model_key);
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
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
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

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct BBox {
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InpaintConfig {
    pub padding: i32,        // Context padding (15-100px)
    pub target_size: u32,    // Inference resolution (256/384/512/768/1024)
    pub mask_threshold: u8,  // Binary threshold (0-50)
    pub mask_erosion: u32,   // Erosion radius (0-10px)
    pub mask_dilation: u32,  // Optional dilation before erosion (0-5px)
    pub feather_radius: u32, // Alpha compositing feather (used by frontend)
    pub debug_mode: bool,    // Export triptychs
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
#[serde(rename_all = "camelCase")]
pub struct InpaintedRegion {
    pub image: Vec<u8>,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub mask: Vec<u8>,
    pub mask_width: u32,
    pub mask_height: u32,
    pub padded_bbox: BBox,
}

async fn run_inpainting_pipeline(
    app: &AppHandle,
    state: &AppState,
    full_image: &DynamicImage,
    full_mask: &GrayImage,
    bbox: &BBox,
    cfg: &InpaintConfig,
) -> anyhow::Result<InpaintedRegion> {
    let (image_width, image_height) = full_image.dimensions();
    let mask_width = full_mask.width();
    let mask_height = full_mask.height();

    tracing::info!(
        "inpaint pipeline start: config={:?}, image={}x{}, mask={}x{}",
        cfg,
        image_width,
        image_height,
        mask_width,
        mask_height
    );

    let padded_min_x = (bbox.xmin - cfg.padding as f32)
        .floor()
        .clamp(0.0, image_width.saturating_sub(1) as f32);
    let padded_min_y = (bbox.ymin - cfg.padding as f32)
        .floor()
        .clamp(0.0, image_height.saturating_sub(1) as f32);
    let padded_max_x = (bbox.xmax + cfg.padding as f32)
        .ceil()
        .clamp(0.0, image_width as f32);
    let padded_max_y = (bbox.ymax + cfg.padding as f32)
        .ceil()
        .clamp(0.0, image_height as f32);

    let crop_x = padded_min_x as u32;
    let crop_y = padded_min_y as u32;
    let crop_x2 = padded_max_x as u32;
    let crop_y2 = padded_max_y as u32;

    if !(crop_x2 > crop_x && crop_y2 > crop_y) {
        anyhow::bail!(
            "Invalid padded bbox after clamping: [{},{} -> {},{}]",
            crop_x,
            crop_y,
            crop_x2,
            crop_y2
        );
    }

    let crop_width = crop_x2 - crop_x;
    let crop_height = crop_y2 - crop_y;

    let padded_bbox = BBox {
        xmin: crop_x as f32,
        ymin: crop_y as f32,
        xmax: crop_x2 as f32,
        ymax: crop_y2 as f32,
    };

    tracing::debug!(
        "Padded bbox: [{},{} -> {},{}] = {}x{}px",
        padded_bbox.xmin,
        padded_bbox.ymin,
        padded_bbox.xmax,
        padded_bbox.ymax,
        crop_width,
        crop_height
    );

    let cropped_image = full_image.crop_imm(crop_x, crop_y, crop_width, crop_height);

    fn extract_and_resize_mask(
        full_mask: &GrayImage,
        bbox: &BBox,
        orig_width: u32,
        orig_height: u32,
        target_width: u32,
        target_height: u32,
        config: &InpaintConfig,
    ) -> anyhow::Result<GrayImage> {
        let mask_width = full_mask.width();
        let mask_height = full_mask.height();
        let scale_x = mask_width as f32 / orig_width as f32;
        let scale_y = mask_height as f32 / orig_height as f32;

        let mask_xmin = (bbox.xmin * scale_x).floor().max(0.0) as u32;
        let mask_ymin = (bbox.ymin * scale_y).floor().max(0.0) as u32;
        let mask_xmax = (bbox.xmax * scale_x).ceil().min(mask_width as f32) as u32;
        let mask_ymax = (bbox.ymax * scale_y).ceil().min(mask_height as f32) as u32;

        let mask_crop_width = mask_xmax.saturating_sub(mask_xmin);
        let mask_crop_height = mask_ymax.saturating_sub(mask_ymin);

        tracing::debug!(
            "Mask extraction: scale=({:.3},{:.3}), mask_bbox=[{},{} -> {},{}], crop={}x{}",
            scale_x,
            scale_y,
            mask_xmin,
            mask_ymin,
            mask_xmax,
            mask_ymax,
            mask_crop_width,
            mask_crop_height
        );

        if mask_crop_width == 0 || mask_crop_height == 0 {
            return Err(anyhow!(
                "Invalid mask crop dimensions: {}x{}",
                mask_crop_width,
                mask_crop_height
            ));
        }

        let mut cropped_mask = GrayImage::new(mask_crop_width, mask_crop_height);
        for y in 0..mask_crop_height {
            for x in 0..mask_crop_width {
                let px = (mask_xmin + x).min(mask_width - 1);
                let py = (mask_ymin + y).min(mask_height - 1);
                let pixel = full_mask.get_pixel(px, py);
                cropped_mask.put_pixel(x, y, *pixel);
            }
        }

        let mut thresholded = cropped_mask.clone();
        for pixel in thresholded.pixels_mut() {
            if pixel[0] < config.mask_threshold {
                pixel[0] = 0;
            }
        }

        let mut morphed = thresholded;
        if config.mask_dilation > 0 {
            morphed = dilate_mask(&morphed, config.mask_dilation);
            tracing::debug!("Applied {}px mask dilation", config.mask_dilation);
        }

        let mut resized_mask = image::imageops::resize(
            &morphed,
            target_width,
            target_height,
            image::imageops::FilterType::Nearest,
        );

        if config.mask_erosion > 0 {
            resized_mask = erode_mask(&resized_mask, config.mask_erosion);
            tracing::debug!("Applied {}px mask erosion", config.mask_erosion);
        }

        tracing::debug!(
            "Mask resized: {}x{} -> {}x{} (threshold={}, erosion={}px, dilation={}px)",
            mask_crop_width,
            mask_crop_height,
            target_width,
            target_height,
            config.mask_threshold,
            config.mask_erosion,
            config.mask_dilation
        );

        Ok(resized_mask)
    }

    fn dilate_mask(mask: &GrayImage, kernel_size: u32) -> GrayImage {
        use imageproc::distance_transform::Norm;
        use imageproc::morphology::dilate;

        dilate(mask, Norm::LInf, kernel_size as u8)
    }

    fn erode_mask(mask: &GrayImage, kernel_size: u32) -> GrayImage {
        use imageproc::distance_transform::Norm;
        use imageproc::morphology::dilate_mut;

        let mut result = mask.clone();

        for pixel in result.pixels_mut() {
            pixel[0] = 255 - pixel[0];
        }

        dilate_mut(&mut result, Norm::LInf, kernel_size as u8);

        for pixel in result.pixels_mut() {
            pixel[0] = 255 - pixel[0];
        }

        result
    }

    let cropped_mask = extract_and_resize_mask(
        full_mask,
        &padded_bbox,
        image_width,
        image_height,
        crop_width,
        crop_height,
        cfg,
    )?;

    if cfg.debug_mode {
        save_debug_triptych(app, &cropped_image, &cropped_mask, bbox, &padded_bbox)?;
    }

    tracing::info!(
        "Running LaMa inference with target_size={}",
        cfg.target_size
    );

    let mask_dynamic = image::DynamicImage::ImageLuma8(cropped_mask.clone());

    let inpainted_crop = state
        .lama
        .lock()
        .await
        .inference_with_size(&cropped_image, &mask_dynamic, cfg.target_size)
        .context("Failed to perform inpainting")?;

    tracing::info!("LaMa inference completed successfully");

    if cfg.debug_mode {
        save_debug_output(app, &cropped_image, &cropped_mask, &inpainted_crop, bbox)?;
    }

    let mut output_rgba = inpainted_crop.to_rgba8();
    let actual_width = output_rgba.width();
    let actual_height = output_rgba.height();

    tracing::debug!(
        "[inpaint] raw LaMa output dimensions: {}x{} (target {}x{})",
        actual_width,
        actual_height,
        crop_width,
        crop_height
    );

    if actual_width != crop_width || actual_height != crop_height {
        tracing::warn!(
            "[inpaint] correcting LaMa output from {}x{} to {}x{}",
            actual_width,
            actual_height,
            crop_width,
            crop_height
        );

        let resized = image::DynamicImage::ImageRgba8(output_rgba)
            .resize_exact(
                crop_width,
                crop_height,
                image::imageops::FilterType::CatmullRom,
            )
            .to_rgba8();

        tracing::info!(
            "[inpaint] resampled buffer: {} bytes for {}x{} region",
            resized.len(),
            crop_width,
            crop_height
        );

        output_rgba = resized;
    }

    let mut output_pixels = output_rgba.into_raw();
    let expected_pixel_bytes = (crop_width as usize)
        .saturating_mul(crop_height as usize)
        .saturating_mul(4);

    if output_pixels.len() != expected_pixel_bytes {
        tracing::error!(
            "[inpaint] pixel buffer mismatch after correction: expected={} actual={} bbox=[{},{} -> {},{}]",
            expected_pixel_bytes,
            output_pixels.len(),
            padded_bbox.xmin,
            padded_bbox.ymin,
            padded_bbox.xmax,
            padded_bbox.ymax
        );

        if output_pixels.len() < expected_pixel_bytes {
            tracing::warn!(
                "[inpaint] padding output buffer from {} to {} bytes",
                output_pixels.len(),
                expected_pixel_bytes
            );
            output_pixels.resize(expected_pixel_bytes, 0);
        } else {
            tracing::warn!(
                "[inpaint] truncating output buffer from {} to {} bytes",
                output_pixels.len(),
                expected_pixel_bytes
            );
            output_pixels.truncate(expected_pixel_bytes);
        }
    } else {
        tracing::debug!(
            "[inpaint] pixel buffer ok: {} bytes for {}x{} region",
            output_pixels.len(),
            crop_width,
            crop_height
        );
    }
    let mask_bytes = cropped_mask.into_raw();

    Ok(InpaintedRegion {
        image: output_pixels,
        x: crop_x,
        y: crop_y,
        width: crop_width,
        height: crop_height,
        mask: mask_bytes,
        mask_width: crop_width,
        mask_height: crop_height,
        padded_bbox,
    })
}

#[tauri::command]
pub async fn cache_inpainting_data(
    app: AppHandle,
    image_png: Vec<u8>,
    mask_png: Vec<u8>,
) -> CommandResult<()> {
    let state = app.state::<AppState>();

    let decoded_image =
        image::load_from_memory(&image_png).context("Failed to decode cached inpaint image")?;
    let decoded_mask = image::load_from_memory(&mask_png)
        .context("Failed to decode cached inpaint mask")?
        .to_luma8();

    {
        let mut image_cache = state.inpaint_image_cache.write().await;
        *image_cache = Some(Arc::new(decoded_image));
    }

    {
        let mut mask_cache = state.inpaint_mask_cache.write().await;
        *mask_cache = Some(Arc::new(decoded_mask));
    }

    tracing::info!("Inpainting cache primed with image and mask data");

    Ok(())
}

#[tauri::command]
pub async fn inpaint_region_cached(
    app: AppHandle,
    bbox: BBox,
    padding: Option<i32>,
    debug_mode: Option<bool>,
    config: Option<InpaintConfig>,
) -> CommandResult<InpaintedRegion> {
    let state = app.state::<AppState>();

    let mut cfg = config.unwrap_or_default();
    if let Some(padding) = padding {
        cfg.padding = padding;
    }
    if let Some(debug_mode) = debug_mode {
        cfg.debug_mode = debug_mode;
    }

    let image_arc = {
        let guard = state.inpaint_image_cache.read().await;
        guard
            .clone()
            .ok_or_else(|| anyhow!("No cached image. Call cache_inpainting_data first."))?
    };

    let mask_arc = {
        let guard = state.inpaint_mask_cache.read().await;
        guard
            .clone()
            .ok_or_else(|| anyhow!("No cached mask. Call cache_inpainting_data first."))?
    };

    let result = run_inpainting_pipeline(&app, &state, &image_arc, &mask_arc, &bbox, &cfg).await?;

    Ok(result)
}

#[tauri::command]
pub async fn clear_inpainting_cache(app: AppHandle) -> CommandResult<()> {
    let state = app.state::<AppState>();

    {
        let mut image_cache = state.inpaint_image_cache.write().await;
        *image_cache = None;
    }

    {
        let mut mask_cache = state.inpaint_mask_cache.write().await;
        *mask_cache = None;
    }

    tracing::info!("Inpainting cache cleared");

    Ok(())
}

#[tauri::command]
pub async fn inpaint_region(
    app: AppHandle,
    image: Vec<u8>,
    image_width: u32,
    image_height: u32,
    mask: Vec<u8>,
    mask_width: u32,
    mask_height: u32,
    bbox: BBox,
    padding: Option<i32>,          // DEPRECATED: Use config.padding instead
    debug_mode: Option<bool>,      // DEPRECATED: Use config.debug_mode instead
    config: Option<InpaintConfig>, // NEW: Full configuration
) -> CommandResult<InpaintedRegion> {
    let state = app.state::<AppState>();

    let mut cfg = config.unwrap_or_default();
    if let Some(padding) = padding {
        cfg.padding = padding;
    }
    if let Some(debug_mode) = debug_mode {
        cfg.debug_mode = debug_mode;
    }

    tracing::info!(
        "inpaint_region (legacy path) with config={:?}, image={}x{}, mask={}x{}",
        cfg,
        image_width,
        image_height,
        mask_width,
        mask_height
    );

    let expected_image_len = (image_width as usize)
        .checked_mul(image_height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| anyhow!("Image dimensions overflow"))?;
    if image.len() != expected_image_len {
        return Err(anyhow!(
            "Image buffer length mismatch: expected {}, got {}",
            expected_image_len,
            image.len()
        )
        .into());
    }

    let expected_mask_len = (mask_width as usize)
        .checked_mul(mask_height as usize)
        .ok_or_else(|| anyhow!("Mask dimensions overflow"))?;
    if mask.len() != expected_mask_len {
        return Err(anyhow!(
            "Mask buffer length mismatch: expected {}, got {}",
            expected_mask_len,
            mask.len()
        )
        .into());
    }

    let full_image_buffer =
        image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(image_width, image_height, image)
            .ok_or_else(|| anyhow!("Failed to reconstruct RGBA image buffer"))?;
    let full_image = DynamicImage::ImageRgba8(full_image_buffer);

    let full_mask_buffer =
        image::ImageBuffer::<image::Luma<u8>, _>::from_raw(mask_width, mask_height, mask)
            .ok_or_else(|| anyhow!("Failed to reconstruct mask buffer"))?;
    let full_mask: GrayImage = full_mask_buffer;

    run_inpainting_pipeline(&app, &state, &full_image, &full_mask, &bbox, &cfg)
        .await
        .map_err(Into::into)
}
/// Simple erosion: shrink white regions by kernel_size pixels
fn erode_mask(mask: &image::GrayImage, kernel_size: u32) -> image::GrayImage {
    use imageproc::distance_transform::Norm;
    use imageproc::morphology::dilate_mut;

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
    let debug_dir = app
        .path()
        .app_cache_dir()
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
    let debug_dir = app
        .path()
        .app_cache_dir()
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
    let app_dir = app
        .path()
        .app_config_dir()
        .context("Failed to get app config directory")?;

    fs::create_dir_all(&app_dir).context("Failed to create app config directory")?;

    let config_path = app_dir.join("gpu_preference.txt");

    fs::write(&config_path, preference.trim()).context("Failed to write GPU preference")?;

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
    use wgpu::{Backends, Instance, InstanceDescriptor};

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

    tracing::info!(
        "Running GPU stress test: {} iterations at {}x{}",
        iterations,
        target_size,
        target_size
    );

    let mut timings = Vec::new();

    for i in 0..iterations {
        let start = std::time::Instant::now();

        // Create test images (512px hardcoded for consistent benchmark)
        let test_image = image::DynamicImage::new_rgb8(512, 512);
        let test_mask = image::DynamicImage::new_luma8(512, 512);

        // Run LaMa inference (uses legacy 512px inference for compatibility)
        state
            .lama
            .lock()
            .await
            .inference(&test_image, &test_mask)
            .context(format!("Stress test iteration {} failed", i + 1))?;

        let elapsed = start.elapsed().as_millis() as u64;
        timings.push(elapsed);

        tracing::debug!(
            "Stress test iteration {}/{}: {}ms",
            i + 1,
            iterations,
            elapsed
        );
    }

    let avg = timings.iter().sum::<u64>() / timings.len() as u64;
    let min = *timings.iter().min().unwrap();
    let max = *timings.iter().max().unwrap();

    tracing::info!(
        "Stress test complete: avg={}ms, min={}ms, max={}ms",
        avg,
        min,
        max
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
    let target = target_lang
        .unwrap_or_else(|| "EN-US".to_string())
        .to_uppercase();

    let request_body = DeepLRequest {
        text: vec![text],
        target_lang: target,
        source_lang: source_lang.map(|s| s.to_uppercase()),
    };

    tracing::debug!(
        "DeepL request: endpoint={}, use_pro={}, body={:?}",
        url,
        use_pro,
        request_body
    );

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
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());

        // Handle specific error codes
        let error_msg = match status.as_u16() {
            401 | 403 => "Invalid API key or insufficient permissions".to_string(),
            429 => "Rate limit exceeded. Please wait and try again.".to_string(),
            456 => {
                "Quota exceeded. For DeepL Free, you've used your 500,000 character/month limit."
                    .to_string()
            }
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
        .context(
            "Failed to connect to Ollama. Make sure Ollama is running on http://localhost:11434",
        )?;

    let status = response.status();

    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
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
pub async fn render_and_export_image(request: RenderRequest) -> CommandResult<Vec<u8>> {
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
    let base_image =
        image::load_from_memory(&request.base_image_buffer).context("Failed to load base image")?;

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
            image::ImageFormat::Png,
        )
        .context("Failed to encode PNG")?;

    tracing::info!(
        "[RUST_EXPORT] Export complete, PNG size: {} bytes",
        png_buffer.len()
    );

    Ok(png_buffer)
}
