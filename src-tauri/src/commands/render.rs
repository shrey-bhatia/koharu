// Tauri commands for image rendering and export

use crate::text_renderer::{render_text_on_image, TextBlock};
use image::{DynamicImage, ImageFormat};
use std::path::PathBuf;
use tauri::State;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    /// Path to base image (determined by frontend based on render method)
    /// - rectangle mode: textless image or original
    /// - lama/newlama modes: inpainted image
    pub base_image_buffer: Vec<u8>,
    
    /// Text blocks to render
    pub text_blocks: Vec<TextBlock>,
    
    /// Render method: "rectangle", "lama", or "newlama"
    pub render_method: String,
    
    /// Default font name
    pub default_font: String,
}

/// Main export command - receives image buffer from frontend
/// Frontend is responsible for selecting the correct base image
#[tauri::command]
pub async fn render_and_export_image(
    request: RenderRequest,
) -> Result<Vec<u8>, String> {
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
        return Err(format!("Invalid render method: {}", request.render_method));
    }
    
    // Load base image from buffer
    let base_image = image::load_from_memory(&request.base_image_buffer)
        .map_err(|e| format!("Failed to load base image: {}", e))?;
    
    tracing::info!(
        "[RUST_EXPORT] Base image loaded: {}x{}",
        base_image.width(),
        base_image.height()
    );
    
    // Load embedded font (Noto Sans as default)
    let font_data = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");
    
    // Render text on image
    let rendered_image = render_text_on_image(
        base_image,
        request.text_blocks,
        &request.render_method,
        font_data,
        &request.default_font,
    )
    .map_err(|e| format!("Rendering failed: {}", e))?;
    
    // Convert to PNG buffer
    let mut png_buffer = Vec::new();
    rendered_image
        .write_to(&mut std::io::Cursor::new(&mut png_buffer), ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    
    tracing::info!("[RUST_EXPORT] Export complete, PNG size: {} bytes", png_buffer.len());
    
    Ok(png_buffer)
}

/// Helper command to verify image routing logic
#[tauri::command]
pub async fn verify_image_routing(
    render_method: String,
    has_inpainted: bool,
    has_textless: bool,
) -> Result<String, String> {
    let expected_image = match render_method.as_str() {
        "rectangle" => {
            if has_textless {
                "textless image"
            } else {
                "original image (fallback)"
            }
        }
        "lama" | "newlama" => {
            if has_inpainted {
                "inpainted image"
            } else {
                "original image (fallback)"
            }
        }
        _ => return Err(format!("Unknown render method: {}", render_method)),
    };
    
    Ok(format!(
        "Render method '{}': Should use {}",
        render_method, expected_image
    ))
}
