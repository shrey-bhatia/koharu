use anyhow::Context;
use tauri::{AppHandle, Manager};
use font_kit::source::SystemSource;

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
