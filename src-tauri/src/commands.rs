use anyhow::Context;
use tauri::{AppHandle, Manager};
use font_kit::source::SystemSource;
use image::GenericImageView;

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

#[tauri::command]
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
) -> CommandResult<InpaintedRegion> {
    let state = app.state::<AppState>();
    let padding = padding.unwrap_or(20);

    // Load images
    let full_image = image::load_from_memory(&image).context("Failed to load image")?;
    let full_mask_img = image::load_from_memory(&mask).context("Failed to load mask")?;
    let full_mask = full_mask_img.to_luma8();

    let (orig_width, orig_height) = full_image.dimensions();

    // Add padding for context
    let padded_bbox = BBox {
        xmin: (bbox.xmin - padding as f32).max(0.0),
        ymin: (bbox.ymin - padding as f32).max(0.0),
        xmax: (bbox.xmax + padding as f32).min(orig_width as f32),
        ymax: (bbox.ymax + padding as f32).min(orig_height as f32),
    };

    // Crop image region
    let crop_width = (padded_bbox.xmax - padded_bbox.xmin) as u32;
    let crop_height = (padded_bbox.ymax - padded_bbox.ymin) as u32;

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

    // Run LaMa inference (convert GrayImage to DynamicImage)
    let mask_dynamic = image::DynamicImage::ImageLuma8(cropped_mask);
    let inpainted_crop = state
        .lama
        .lock()
        .await
        .inference(&cropped_image, &mask_dynamic)
        .context("Failed to perform inpainting")?;

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
    // Scale factors: original → 1024×1024 mask
    let scale_x = 1024.0 / orig_width as f32;
    let scale_y = 1024.0 / orig_height as f32;

    // Map bbox to mask coordinates
    let mask_xmin = (bbox.xmin * scale_x).floor().max(0.0) as u32;
    let mask_ymin = (bbox.ymin * scale_y).floor().max(0.0) as u32;
    let mask_xmax = (bbox.xmax * scale_x).ceil().min(1024.0) as u32;
    let mask_ymax = (bbox.ymax * scale_y).ceil().min(1024.0) as u32;

    let mask_crop_width = mask_xmax - mask_xmin;
    let mask_crop_height = mask_ymax - mask_ymin;

    // Crop mask with bounds checking
    let mut cropped_mask = image::GrayImage::new(mask_crop_width, mask_crop_height);
    for y in 0..mask_crop_height {
        for x in 0..mask_crop_width {
            let px = (mask_xmin + x).min(1023);
            let py = (mask_ymin + y).min(1023);
            let pixel = full_mask.get_pixel(px, py);
            cropped_mask.put_pixel(x, y, *pixel);
        }
    }

    // Resize to match image crop
    let resized_mask = image::imageops::resize(
        &cropped_mask,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    );

    Ok(resized_mask)
}
