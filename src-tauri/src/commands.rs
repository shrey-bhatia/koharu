use anyhow::Context;
use tauri::{AppHandle, Manager};
use font_kit::source::SystemSource;
use image::GenericImageView;
use std::fs;

use crate::{AppState, error::CommandResult};

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
pub async fn ocr(app: AppHandle, image: Vec<u8>) -> CommandResult<String> {
    let state = app.state::<AppState>();

    let img = image::load_from_memory(&image).context("Failed to load image")?;

    let result = state
        .manga_ocr
        .lock()
        .await
        .inference(&img)
        .context("Failed to perform OCR")?;

    Ok(result)
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
    padding: Option<i32>,
    debug_mode: Option<bool>,
) -> CommandResult<InpaintedRegion> {
    let state = app.state::<AppState>();
    let padding = padding.unwrap_or(20);
    let debug = debug_mode.unwrap_or(false);

    // Load images
    let full_image = image::load_from_memory(&image).context("Failed to load image")?;
    let full_mask_img = image::load_from_memory(&mask).context("Failed to load mask")?;
    let full_mask = full_mask_img.to_luma8();

    let (orig_width, orig_height) = full_image.dimensions();
    
    // Log original dimensions
    tracing::debug!(
        "inpaint_region: orig={}x{}, mask={}x{}, bbox=[{},{} -> {},{}], padding={}px",
        orig_width, orig_height,
        full_mask.width(), full_mask.height(),
        bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax,
        padding
    );

    // Add padding for context
    let padded_bbox = BBox {
        xmin: (bbox.xmin - padding as f32).max(0.0),
        ymin: (bbox.ymin - padding as f32).max(0.0),
        xmax: (bbox.xmax + padding as f32).min(orig_width as f32),
        ymax: (bbox.ymax + padding as f32).min(orig_height as f32),
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

    // Extract and resize mask to match crop
    let cropped_mask = extract_and_resize_mask(
        &full_mask,
        &padded_bbox,
        orig_width,
        orig_height,
        crop_width,
        crop_height,
    )?;
    
    // Debug: Save triptych if debug mode enabled
    if debug {
        save_debug_triptych(
            &app,
            &cropped_image,
            &cropped_mask,
            &bbox,
            &padded_bbox,
        )?;
    }

    // Run LaMa inference (convert GrayImage to DynamicImage)
    let mask_dynamic = image::DynamicImage::ImageLuma8(cropped_mask.clone());
    let inpainted_crop = state
        .lama
        .lock()
        .await
        .inference(&cropped_image, &mask_dynamic)
        .context("Failed to perform inpainting")?;
    
    // Debug: Save triptych output if debug mode enabled
    if debug {
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

    // Resize to match image crop using NEAREST for masks (no interpolation)
    let mut resized_mask = image::imageops::resize(
        &cropped_mask,
        target_width,
        target_height,
        image::imageops::FilterType::Nearest,
    );
    
    // Apply slight erosion to pull mask away from edges (prevent halos)
    resized_mask = erode_mask(&resized_mask, 3);
    
    tracing::debug!(
        "Mask resized: {}x{} -> {}x{} (nearest-neighbor + 3px erosion)",
        mask_crop_width, mask_crop_height,
        target_width, target_height
    );

    Ok(resized_mask)
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
