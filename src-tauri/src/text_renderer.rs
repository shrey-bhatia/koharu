// Text rendering module for Koharu
// Handles image composition and text overlay for export

use image::{DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::{draw_filled_rect_mut, draw_text_mut};
use imageproc::rect::Rect as IpRect;
use ab_glyph::{FontArc, PxScale};
use serde::Deserialize;

// RGB color type matching frontend
#[derive(Debug, Deserialize, Clone)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

// Text block structure matching frontend TextBlock type
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
    pub translated_text: Option<String>,
    pub font_size: Option<f32>,
    pub text_color: Option<RgbColor>,
    pub background_color: Option<RgbColor>,
    pub manual_bg_color: Option<RgbColor>,
    pub manual_text_color: Option<RgbColor>,
    pub font_family: Option<String>,
    pub font_weight: Option<String>,
    pub font_stretch: Option<String>,
    pub letter_spacing: Option<f32>,
    pub line_height: Option<f32>,
    // Outline from appearance analysis
    pub appearance: Option<AppearanceData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceData {
    pub source_outline_color: Option<RgbColor>,
    pub outline_width_px: Option<f32>,
}

/// Render text on image following the exact same logic as JavaScript export
/// 
/// Image routing:
/// - rectangle mode: base_image should be textless or original
/// - lama/newlama modes: base_image should be inpainted
pub fn render_text_on_image(
    base_image: DynamicImage,
    text_blocks: Vec<TextBlock>,
    render_method: &str,
    font_data: &[u8],
    default_font: &str,
) -> anyhow::Result<DynamicImage> {
    let mut img = base_image.to_rgba8();

    // Load font using ab_glyph
    let font = FontArc::try_from_vec(font_data.to_vec())
        .map_err(|_| anyhow::anyhow!("Failed to load font"))?;

    // Step 1: Draw rectangles ONLY for Rectangle Fill mode
    // (lama/newlama render text directly over inpainted image)
    if render_method == "rectangle" {
        tracing::info!("[RUST_EXPORT] Drawing rectangles for Rectangle Fill mode");
        for block in &text_blocks {
            if block.background_color.is_none() && block.manual_bg_color.is_none() {
                continue;
            }

            let bg_color = block.manual_bg_color.as_ref()
                .or(block.background_color.as_ref())
                .unwrap();

            draw_rounded_rectangle(
                &mut img,
                block.xmin,
                block.ymin,
                block.xmax - block.xmin,
                block.ymax - block.ymin,
                5.0, // radius
                Rgba([bg_color.r, bg_color.g, bg_color.b, 255]),
            );
        }
    } else {
        tracing::info!("[RUST_EXPORT] Skipping rectangles for LaMa/NewLaMa mode");
    }

    // Step 2: Draw debug text in 4 corners with different methods
    let (width, height) = img.dimensions();
    let debug_text = "DEBUG TEXT";

    // Method 1: Red text in top-left (current method)
    draw_debug_text_method1(&mut img, &font, debug_text, width, height)?;

    // Method 2: Black text in top-right (simple draw_text_mut)
    draw_debug_text_method2(&mut img, &font, debug_text, width, height)?;

    // Method 3: Yellow text in bottom-left (different scaling)
    draw_debug_text_method3(&mut img, &font, debug_text, width, height)?;

    // Method 4: Blue text in bottom-right (character-by-character)
    draw_debug_text_method4(&mut img, &font, debug_text, width, height)?;

    // Step 3: Draw translated text (original logic)
    tracing::info!("[RUST_EXPORT] Drawing text for {} blocks", text_blocks.len());

    for (i, block) in text_blocks.iter().enumerate() {
        // Skip blocks without required properties (same as JS logic)
        if block.translated_text.is_none() || block.font_size.is_none() {
            tracing::debug!("[RUST_EXPORT] Skipping block {}: missing text or fontSize", i);
            continue;
        }

        let text_color_opt = block.manual_text_color.as_ref()
            .or(block.text_color.as_ref());

        if text_color_opt.is_none() {
            tracing::debug!("[RUST_EXPORT] Skipping block {}: missing textColor", i);
            continue;
        }

        let translated_text = block.translated_text.as_ref().unwrap();
        let font_size = block.font_size.unwrap();
        let text_color = text_color_opt.unwrap();
        let font_family = block.font_family.as_ref()
            .map(|s| s.as_str())
            .unwrap_or(default_font);
        let letter_spacing = block.letter_spacing.unwrap_or(0.0);
        let line_height_multiplier = block.line_height.unwrap_or(1.2);

        tracing::debug!("[RUST_EXPORT] Drawing block {}: '{}' font={} size={}",
            i, &translated_text[..translated_text.len().min(30)], font_family, font_size);

        // Check for outline
        let has_outline = block.appearance.as_ref()
            .and_then(|a| a.source_outline_color.as_ref().zip(a.outline_width_px))
            .is_some();

        draw_text_block(
            &mut img,
            block,
            &font,
            translated_text,
            font_size,
            text_color,
            letter_spacing,
            line_height_multiplier,
            has_outline,
        )?;
    }

    Ok(DynamicImage::ImageRgba8(img))
}

/// Draw a rounded rectangle (matching JavaScript quadraticCurveTo logic)
fn draw_rounded_rectangle(
    img: &mut RgbaImage,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
    color: Rgba<u8>,
) {
    let x = x as i32;
    let y = y as i32;
    let width = width as u32;
    let height = height as u32;
    let radius = radius as u32;
    
    // For now, draw simple rectangle
    // TODO: Implement proper rounded corners using Bézier curves
    let rect = IpRect::at(x, y).of_size(width, height);
    draw_filled_rect_mut(img, rect, color);
}

/// Draw text block with proper wrapping, centering, and spacing
/// Matches JavaScript drawTextWithSpacing logic exactly
fn draw_text_block(
    img: &mut RgbaImage,
    block: &TextBlock,
    font: &FontArc,
    text: &str,
    font_size: f32,
    text_color: &RgbColor,
    letter_spacing: f32,
    line_height_multiplier: f32,
    has_outline: bool,
) -> anyhow::Result<()> {
    let scale = PxScale::from(font_size);
    let text_rgba = Rgba([text_color.r, text_color.g, text_color.b, 255]);
    
    let box_width = block.xmax - block.xmin;
    let box_height = block.ymax - block.ymin;
    let max_width = box_width * 0.9; // 10% padding
    let center_x = (block.xmin + block.xmax) / 2.0;
    let center_y = (block.ymin + block.ymax) / 2.0;
    
    // Word wrap logic (matches JS)
    let words: Vec<&str> = text.split(' ').collect();
    let mut lines: Vec<String> = Vec::new();
    let mut current_line = String::new();
    
    for word in words {
        let test_line = if current_line.is_empty() {
            word.to_string()
        } else {
            format!("{} {}", current_line, word)
        };
        
        let test_width = if letter_spacing == 0.0 {
            measure_text_width(&test_line, font, scale)
        } else {
            measure_text_width_with_spacing(&test_line, font, scale, letter_spacing)
        };
        
        if test_width > max_width && !current_line.is_empty() {
            lines.push(current_line.clone());
            current_line = word.to_string();
        } else {
            current_line = test_line;
        }
    }
    if !current_line.is_empty() {
        lines.push(current_line);
    }
    
    // Calculate vertical positioning (matches JS)
    let line_height = font_size * line_height_multiplier;
    let total_height = lines.len() as f32 * line_height;
    
    let start_y = if total_height > box_height * 0.9 {
        block.ymin + line_height / 2.0
    } else {
        center_y - ((lines.len() as f32 - 1.0) * line_height) / 2.0
    };
    
    // Draw each line
    for (i, line) in lines.iter().enumerate() {
        let y = start_y + i as f32 * line_height;
        
        // Draw outline first if present (matches JS order)
        if has_outline {
            if let Some(appearance) = &block.appearance {
                if let (Some(outline_color), Some(outline_width)) = 
                    (&appearance.source_outline_color, appearance.outline_width_px)
                {
                    let outline_rgba = Rgba([
                        outline_color.r,
                        outline_color.g,
                        outline_color.b,
                        255,
                    ]);
                    
                    if letter_spacing == 0.0 {
                        // Simple stroke - draw with offset
                        draw_text_with_outline(
                            img,
                            center_x as i32,
                            y as i32,
                            scale,
                            font,
                            line,
                            outline_rgba,
                            outline_width as i32,
                        );
                    } else {
                        // Character-by-character stroke
                        draw_text_with_spacing_and_outline(
                            img,
                            center_x,
                            y,
                            scale,
                            font,
                            line,
                            outline_rgba,
                            outline_width as i32,
                            letter_spacing,
                        );
                    }
                }
            }
        }
        
        // Draw fill on top (matches JS: fill after stroke)
        if letter_spacing == 0.0 {
            // Simple rendering (matches JS: ctx.fillText(text, x, y, maxWidth))
            draw_text_mut(
                img,
                text_rgba,
                center_x as i32,
                y as i32,
                scale,
                font,
                line,
            );
        } else {
            // Manual letter spacing (matches JS character-by-character logic)
            draw_text_with_spacing(
                img,
                center_x,
                y,
                scale,
                font,
                line,
                text_rgba,
                letter_spacing,
            );
        }
    }
    
    Ok(())
}

/// Measure text width without letter spacing
fn measure_text_width(text: &str, font: &FontArc, scale: PxScale) -> f32 {
    use ab_glyph::{Font, ScaleFont};
    
    let scaled_font = font.as_scaled(scale);
    let mut width = 0.0;
    
    for c in text.chars() {
        let glyph_id = font.glyph_id(c);
        width += scaled_font.h_advance(glyph_id);
    }
    
    width
}

/// Measure text width with manual letter spacing (matches JS logic)
fn measure_text_width_with_spacing(text: &str, font: &FontArc, scale: PxScale, spacing: f32) -> f32 {
    let mut total_width = 0.0;
    let chars: Vec<char> = text.chars().collect();
    
    for (i, c) in chars.iter().enumerate() {
        let char_str = c.to_string();
        total_width += measure_text_width(&char_str, font, scale);
        if i < chars.len() - 1 {
            total_width += spacing;
        }
    }
    
    total_width
}

/// Draw text with manual letter spacing (matches JS drawTextWithSpacing)
fn draw_text_with_spacing(
    img: &mut RgbaImage,
    center_x: f32,
    y: f32,
    scale: PxScale,
    font: &FontArc,
    text: &str,
    color: Rgba<u8>,
    letter_spacing: f32,
) {
    let total_width = measure_text_width_with_spacing(text, font, scale, letter_spacing);
    let mut current_x = center_x - total_width / 2.0;
    
    for c in text.chars() {
        let char_str = c.to_string();
        let char_width = measure_text_width(&char_str, font, scale);
        let char_center_x = current_x + char_width / 2.0;
        
        draw_text_mut(
            img,
            color,
            char_center_x as i32,
            y as i32,
            scale,
            font,
            &char_str,
        );
        
        current_x += char_width + letter_spacing;
    }
}

/// Draw text with outline (simple offset approach)
fn draw_text_with_outline(
    img: &mut RgbaImage,
    x: i32,
    y: i32,
    scale: PxScale,
    font: &FontArc,
    text: &str,
    outline_color: Rgba<u8>,
    outline_width: i32,
) {
    // Draw outline by offsetting in 8 directions
    let offsets = [
        (-1, -1), (0, -1), (1, -1),
        (-1,  0),          (1,  0),
        (-1,  1), (0,  1), (1,  1),
    ];
    
    for (dx, dy) in offsets.iter() {
        draw_text_mut(
            img,
            outline_color,
            x + dx * outline_width,
            y + dy * outline_width,
            scale,
            font,
            text,
        );
    }
}

/// Draw text with spacing AND outline
fn draw_text_with_spacing_and_outline(
    img: &mut RgbaImage,
    center_x: f32,
    y: f32,
    scale: PxScale,
    font: &FontArc,
    text: &str,
    outline_color: Rgba<u8>,
    outline_width: i32,
    letter_spacing: f32,
) {
    let total_width = measure_text_width_with_spacing(text, font, scale, letter_spacing);
    let mut current_x = center_x - total_width / 2.0;
    
    for c in text.chars() {
        let char_str = c.to_string();
        let char_width = measure_text_width(&char_str, font, scale);
        let char_center_x = current_x + char_width / 2.0;
        
        draw_text_with_outline(
            img,
            char_center_x as i32,
            y as i32,
            scale,
            font,
            &char_str,
            outline_color,
            outline_width,
        );
        
        current_x += char_width + letter_spacing;
    }
}

// Debug methods for testing different rendering approaches
// Method 1: Red text in top-left (using current draw_text_block approach)
fn draw_debug_text_method1(
    img: &mut RgbaImage,
    font: &FontArc,
    text: &str,
    img_width: u32,
    img_height: u32,
) -> anyhow::Result<()> {
    let scale = PxScale::from(24.0);
    let x = 20;
    let y = 30;
    let color = Rgba([255, 0, 0, 255]); // Red
    
    draw_text_mut(img, color, x, y, scale, font, text);
    Ok(())
}

// Method 2: Black text in top-right (simple draw_text_mut)
fn draw_debug_text_method2(
    img: &mut RgbaImage,
    font: &FontArc,
    text: &str,
    img_width: u32,
    img_height: u32,
) -> anyhow::Result<()> {
    let scale = PxScale::from(24.0);
    let text_width = measure_text_width(text, font, scale);
    let x = (img_width as i32) - (text_width as i32) - 20;
    let y = 30;
    let color = Rgba([0, 0, 0, 255]); // Black
    
    draw_text_mut(img, color, x, y, scale, font, text);
    Ok(())
}

// Method 3: Yellow text in bottom-left (different scaling approach)
fn draw_debug_text_method3(
    img: &mut RgbaImage,
    font: &FontArc,
    text: &str,
    img_width: u32,
    img_height: u32,
) -> anyhow::Result<()> {
    let scale = PxScale::from(20.0);
    let x = 20;
    let y = (img_height as i32) - 50;
    let color = Rgba([255, 255, 0, 255]); // Yellow
    
    // Draw background rectangle first
    for dy in 0..30 {
        for dx in 0..200 {
            let px = x + dx;
            let py = y + dy;
            if px < img_width as i32 && py < img_height as i32 && px >= 0 && py >= 0 {
                img.put_pixel(px as u32, py as u32, Rgba([0, 0, 0, 128]));
            }
        }
    }
    
    draw_text_mut(img, color, x, y, scale, font, text);
    Ok(())
}

// Method 4: Blue text in bottom-right (character-by-character drawing)
fn draw_debug_text_method4(
    img: &mut RgbaImage,
    font: &FontArc,
    text: &str,
    img_width: u32,
    img_height: u32,
) -> anyhow::Result<()> {
    let scale = PxScale::from(24.0);
    let color = Rgba([0, 0, 255, 255]); // Blue
    let mut current_x = (img_width as i32) - 20;
    let y = (img_height as i32) - 30;
    
    // Draw from right to left, character by character
    for c in text.chars().rev() {
        let char_str = c.to_string();
        let char_width = measure_text_width(&char_str, font, scale);
        current_x -= char_width as i32;
        
        draw_text_mut(img, color, current_x, y, scale, font, &char_str);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_measure_text_width() {
        let font_data = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");
        let font = FontArc::try_from_vec(font_data.to_vec()).unwrap();
        let scale = PxScale::from(16.0);
        
        let width = measure_text_width("Hello", &font, scale);
        assert!(width > 0.0);
    }
    
    #[test]
    fn test_measure_text_width_with_spacing() {
        let font_data = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");
        let font = FontArc::try_from_vec(font_data.to_vec()).unwrap();
        let scale = PxScale::from(16.0);
        
        let width_no_spacing = measure_text_width("Hello", &font, scale);
        let width_with_spacing = measure_text_width_with_spacing("Hello", &font, scale, 5.0);
        
        assert!(width_with_spacing > width_no_spacing + 15.0);
    }
}
