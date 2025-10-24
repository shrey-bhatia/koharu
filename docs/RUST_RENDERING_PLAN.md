# Rust-Side Image Rendering Implementation Plan

## Overview
Move export rendering from JavaScript Canvas to Rust backend using existing crates.

## Why This Approach?

### ✅ Advantages:
1. **Already have dependencies**: `image`, `imageproc`, `font-kit` in Cargo.toml
2. **No canvas issues**: Rust image processing is deterministic
3. **Better performance**: Native code vs JavaScript
4. **Consistent rendering**: Same output on all platforms
5. **Leverages existing infrastructure**: ML models already in Rust
6. **No network overhead**: Desktop app runs locally

### ❌ Why NOT Puppeteer/Headless Browser:
- Adds ~200MB Chromium dependency
- Overkill for desktop app
- Network calls in offline app
- Already have native rendering capability

## Implementation Steps

### Phase 1: Add Text Rendering Crate (30 min)

**Add to `src-tauri/Cargo.toml`:**
```toml
[dependencies]
# ... existing deps ...
ab_glyph = "0.2"  # High-quality text rendering
rusttype = "0.9"  # Alternative: simpler API
```

### Phase 2: Create Rust Text Rendering Module (2-3 hours)

**File: `src-tauri/src/text_renderer.rs`**

```rust
use image::{DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::{draw_text_mut, draw_filled_rect_mut};
use imageproc::rect::Rect;
use ab_glyph::{FontRef, PxScale};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct TextBlock {
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
    pub translated_text: String,
    pub font_size: f32,
    pub text_color: RgbColor,
    pub background_color: Option<RgbColor>,
    pub font_family: String,
    pub font_weight: String,
    pub letter_spacing: f32,
    pub line_height: f32,
    // Outline support
    pub outline_color: Option<RgbColor>,
    pub outline_width: Option<f32>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

pub fn render_text_on_image(
    mut base_image: DynamicImage,
    text_blocks: Vec<TextBlock>,
    render_method: &str,
    font_data: &[u8], // Font bytes
) -> Result<DynamicImage, Box<dyn std::error::Error>> {
    let mut img = base_image.to_rgba8();
    
    for block in text_blocks {
        // 1. Draw background rectangle (if Rectangle Fill mode)
        if render_method == "rectangle" {
            if let Some(bg_color) = block.background_color {
                draw_rounded_rect(
                    &mut img,
                    block.xmin as i32,
                    block.ymin as i32,
                    (block.xmax - block.xmin) as u32,
                    (block.ymax - block.ymin) as u32,
                    5, // radius
                    Rgba([bg_color.r, bg_color.g, bg_color.b, 255]),
                );
            }
        }
        
        // 2. Draw text with proper wrapping and spacing
        let font = FontRef::try_from_slice(font_data)?;
        draw_text_block(&mut img, &block, &font)?;
    }
    
    Ok(DynamicImage::ImageRgba8(img))
}

fn draw_rounded_rect(
    img: &mut RgbaImage,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    radius: u32,
    color: Rgba<u8>,
) {
    // Use imageproc to draw rounded rectangle
    // (Implementation using draw_filled_rect_mut + corners)
    let rect = Rect::at(x, y).of_size(width, height);
    draw_filled_rect_mut(img, rect, color);
}

fn draw_text_block(
    img: &mut RgbaImage,
    block: &TextBlock,
    font: &FontRef,
) -> Result<(), Box<dyn std::error::Error>> {
    let scale = PxScale::from(block.font_size);
    let text_color = Rgba([
        block.text_color.r,
        block.text_color.g,
        block.text_color.b,
        255,
    ]);
    
    // Word wrap logic
    let box_width = (block.xmax - block.xmin) * 0.9; // 10% padding
    let lines = wrap_text(&block.translated_text, box_width, font, scale);
    
    // Calculate vertical centering
    let line_height = block.font_size * block.line_height;
    let total_height = lines.len() as f32 * line_height;
    let box_height = block.ymax - block.ymin;
    
    let start_y = if total_height > box_height * 0.9 {
        block.ymin + line_height / 2.0
    } else {
        (block.ymin + block.ymax) / 2.0 - ((lines.len() as f32 - 1.0) * line_height) / 2.0
    };
    
    // Draw each line
    for (i, line) in lines.iter().enumerate() {
        let y = start_y + i as f32 * line_height;
        let center_x = (block.xmin + block.xmax) / 2.0;
        
        // Draw outline if present
        if let (Some(outline_color), Some(outline_width)) = 
            (&block.outline_color, block.outline_width) 
        {
            let outline_rgba = Rgba([
                outline_color.r,
                outline_color.g,
                outline_color.b,
                255,
            ]);
            draw_text_with_outline(
                img,
                outline_rgba,
                center_x as i32,
                y as i32,
                scale,
                font,
                line,
                outline_width,
            );
        }
        
        // Draw text
        if block.letter_spacing == 0.0 {
            // Simple rendering
            draw_text_mut(img, text_color, center_x as i32, y as i32, scale, font, line);
        } else {
            // Manual letter spacing
            draw_text_with_spacing(
                img,
                text_color,
                center_x as i32,
                y as i32,
                scale,
                font,
                line,
                block.letter_spacing,
            );
        }
    }
    
    Ok(())
}

fn wrap_text(
    text: &str,
    max_width: f32,
    font: &FontRef,
    scale: PxScale,
) -> Vec<String> {
    // Word wrapping implementation
    let words: Vec<&str> = text.split(' ').collect();
    let mut lines = Vec::new();
    let mut current_line = String::new();
    
    for word in words {
        let test_line = if current_line.is_empty() {
            word.to_string()
        } else {
            format!("{} {}", current_line, word)
        };
        
        // Measure text width (using ab_glyph metrics)
        let width = measure_text_width(&test_line, font, scale);
        
        if width > max_width && !current_line.is_empty() {
            lines.push(current_line.clone());
            current_line = word.to_string();
        } else {
            current_line = test_line;
        }
    }
    
    if !current_line.is_empty() {
        lines.push(current_line);
    }
    
    lines
}

fn measure_text_width(text: &str, font: &FontRef, scale: PxScale) -> f32 {
    // Use ab_glyph to calculate text width
    let mut width = 0.0;
    for c in text.chars() {
        if let Some(glyph) = font.glyph_id(c).filter(|&id| id != font.glyph_id('\0')) {
            let glyph = glyph.with_scale(scale);
            width += font.h_advance(glyph);
        }
    }
    width
}

fn draw_text_with_spacing(
    img: &mut RgbaImage,
    color: Rgba<u8>,
    x: i32,
    y: i32,
    scale: PxScale,
    font: &FontRef,
    text: &str,
    letter_spacing: f32,
) {
    // Character-by-character rendering with spacing
    let total_width = measure_text_width(text, font, scale) + 
        (text.len() as f32 - 1.0) * letter_spacing;
    let mut current_x = x as f32 - total_width / 2.0;
    
    for c in text.chars() {
        let char_str = c.to_string();
        draw_text_mut(img, color, current_x as i32, y, scale, font, &char_str);
        
        let char_width = measure_text_width(&char_str, font, scale);
        current_x += char_width + letter_spacing;
    }
}

fn draw_text_with_outline(
    img: &mut RgbaImage,
    outline_color: Rgba<u8>,
    x: i32,
    y: i32,
    scale: PxScale,
    font: &FontRef,
    text: &str,
    outline_width: f32,
) {
    // Draw text multiple times with offset to simulate outline
    let offsets = [
        (-1, -1), (0, -1), (1, -1),
        (-1,  0),          (1,  0),
        (-1,  1), (0,  1), (1,  1),
    ];
    
    let width_i = outline_width as i32;
    for (dx, dy) in offsets.iter() {
        draw_text_mut(
            img,
            outline_color,
            x + dx * width_i,
            y + dy * width_i,
            scale,
            font,
            text,
        );
    }
}
```

### Phase 3: Create Tauri Command (30 min)

**File: `src-tauri/src/commands.rs` (or add to existing)**

```rust
use crate::text_renderer::{render_text_on_image, TextBlock};
use image::DynamicImage;
use tauri::State;

#[tauri::command]
pub async fn render_and_export_image(
    base_image_path: String,
    text_blocks: Vec<TextBlock>,
    render_method: String,
    output_path: String,
) -> Result<(), String> {
    // 1. Load base image
    let base_image = image::open(&base_image_path)
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    // 2. Load default font (embed or from system)
    let font_data = include_bytes!("../assets/fonts/default.ttf");
    
    // 3. Render text on image
    let rendered_image = render_text_on_image(
        base_image,
        text_blocks,
        &render_method,
        font_data,
    )
    .map_err(|e| format!("Rendering failed: {}", e))?;
    
    // 4. Save to disk
    rendered_image.save(&output_path)
        .map_err(|e| format!("Failed to save: {}", e))?;
    
    Ok(())
}
```

**Register command in `main.rs`:**
```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            render_and_export_image,
            // ... existing commands
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Phase 4: Update Frontend (1 hour)

**File: `next/components/render-panel.tsx`**

```typescript
const exportImage = async () => {
  try {
    setExporting(true)
    setError(null)

    if (!image) return

    // Prepare text blocks for Rust
    const textBlocksForRust = textBlocks.map(block => ({
      xmin: block.xmin,
      ymin: block.ymin,
      xmax: block.xmax,
      ymax: block.ymax,
      translated_text: block.translatedText || '',
      font_size: block.fontSize || 16,
      text_color: block.manualTextColor || block.textColor || { r: 0, g: 0, b: 0 },
      background_color: renderMethod === 'rectangle' 
        ? (block.manualBgColor || block.backgroundColor) 
        : null,
      font_family: block.fontFamily || defaultFont,
      font_weight: block.fontWeight || 'normal',
      letter_spacing: block.letterSpacing || 0,
      line_height: block.lineHeight || 1.2,
      outline_color: block.appearance?.sourceOutlineColor || null,
      outline_width: block.appearance?.outlineWidthPx || null,
    }))

    // Determine base image
    let baseImagePath: string
    if (renderMethod === 'lama' || renderMethod === 'newlama') {
      baseImagePath = inpaintedImage ? /* path to inpainted */ : /* path to original */
    } else if (renderMethod === 'rectangle') {
      baseImagePath = pipelineStages.textless ? /* path to textless */ : /* path to original */
    } else {
      baseImagePath = /* path to original */
    }

    // Call Rust backend
    const outputPath = `translated-manga-${Date.now()}.png`
    
    await invoke('render_and_export_image', {
      baseImagePath,
      textBlocks: textBlocksForRust,
      renderMethod,
      outputPath,
    })

    // Open save dialog
    await fileSave(
      new Blob([/* read from outputPath */]), 
      {
        fileName: outputPath,
        extensions: ['.png'],
        description: 'PNG Image',
      }
    )

    console.log('Image exported successfully!')
  } catch (err) {
    console.error('Export error:', err)
    setError(err instanceof Error ? err.message : 'Failed to export image')
  } finally {
    setExporting(false)
  }
}
```

## Timeline

- **Phase 1**: 30 minutes
- **Phase 2**: 2-3 hours (most complex)
- **Phase 3**: 30 minutes
- **Phase 4**: 1 hour
- **Testing**: 1 hour

**Total: 5-6 hours**

## Benefits vs Canvas Approach

| Aspect | Canvas (Current) | Rust (Proposed) |
|--------|------------------|-----------------|
| API Compatibility | ❌ Browser-dependent | ✅ Consistent |
| Performance | Medium | ⚡ High |
| Text Quality | Medium | ✅ High (ab_glyph) |
| Letter Spacing | ⚠️ Manual impl | ✅ Native support |
| Font Loading | ⚠️ Async issues | ✅ Embedded |
| Debugging | Hard (browser) | ✅ Easy (logs) |
| File Saving | Complex (blob) | ✅ Direct write |

## Fallback Plan

If text rendering is too complex, use **hybrid approach**:
1. Rust draws rectangles
2. Rust loads fonts
3. JavaScript passes pre-calculated glyph positions
4. Rust draws glyphs

## Questions to Answer

1. **Where are images currently stored?**
   - Tauri temp directory?
   - User's file system?
   - In-memory only?

2. **How to handle fonts?**
   - Embed default font in binary
   - Load from system fonts
   - User-selectable fonts?

3. **Preview vs Export:**
   - Keep React-Konva for preview (works fine)
   - Use Rust only for final export
   - OR: Rust generates preview images too?

## Next Steps

1. **Prototype Phase 2** (text_renderer.rs) with simple example
2. **Test with one text block** before full implementation
3. **Benchmark** Rust vs Canvas performance
4. **Compare** output quality side-by-side

## Alternative: Use Existing `imageproc` Only

If `ab_glyph` is too complex, `imageproc` already has `draw_text_mut`:

```rust
use imageproc::drawing::draw_text_mut;
use rusttype::{Font, Scale};

let font_data = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");
let font = Font::try_from_bytes(font_data).unwrap();
let scale = Scale::uniform(block.font_size);

draw_text_mut(
    &mut img,
    text_color,
    x,
    y,
    scale,
    &font,
    &block.translated_text,
);
```

This is simpler but has fewer features (no letter spacing, limited layout).

## Recommendation

**Start with `imageproc` + `rusttype` for MVP**, then upgrade to `ab_glyph` if you need:
- Advanced letter spacing
- Better text metrics
- More font features

Your existing dependencies already support basic text rendering!
