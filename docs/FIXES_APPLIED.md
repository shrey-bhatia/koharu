# FIXES APPLIED - Read This First!

## What Was Wrong

### The White Inpainting Bug 🐛
**Root Cause**: The app was extracting background colors from the INPAINTED image instead of the ORIGINAL image.

**Why This Caused White Fills**:
1. You run Inpaint → LaMa removes text and fills with surrounding context (usually white speech bubbles)
2. You click Process → App extracts colors from this already-inpainted (white-filled) image
3. Result: White rectangles everywhere because it's sampling white pixels!

**The Fix ✅**: 
- Color extraction now ALWAYS uses the original image
- LaMa inpainting result is only used as the base canvas for rendering
- Colors come from the original manga, not the inpainted version

## Changes Made

### 1. Fixed Color Extraction (render-panel.tsx)
```typescript
// OLD (WRONG):
const baseImage = inpaintedImage ? inpaintedImage.bitmap : image.bitmap
const colors = await extractBackgroundColor(baseImage, block, 10)
// ↑ This extracted from white-filled inpainted image!

// NEW (CORRECT):
const colorSourceImage = image.bitmap  // Always use original!
const colors = await extractBackgroundColor(colorSourceImage, block, 10)
// ↑ This extracts from original manga colors
```

### 2. Disabled Inpaint for Rectangle Fill (inpaint-panel.tsx)
- Rectangle fill doesn't need AI inpainting
- Button is now disabled with helpful explanation
- Avoids confusion about when to use Inpaint

### 3. Added GPU Status Indicator (render-panel.tsx)
- Shows which GPU/provider is active (CUDA/DirectML/CPU)
- Displays device name if available
- Shows warmup inference time
- Warns if CPU fallback detected

### 4. Increased Inpainting Padding
- Option 2 (LaMa): 40px padding (was 25px)
- Option 3 (NewLaMa): 50px padding (was 25px)
- More context = better color matching by LaMa

## How to Test

### Test 1: Rectangle Fill (Fastest, Most Predictable)
1. Load a manga page with text on colored backgrounds
2. Run: Detection → OCR → Translation
3. Select "Rectangle Fill" in Render panel
4. Click "Process"
5. **Expected**: Rectangles should match original background colors (brown for dog, etc.)
6. Click "Export"

### Test 2: LaMa AI Inpainting
1. Load same manga page
2. Run: Detection → OCR → Translation
3. Select "LaMa AI (Basic)" or "NewLaMa (Best Quality)"
4. Click "Inpaint" in Inpaint panel (wait for completion)
5. Click "Process" in Render panel
6. **Expected**: Text removed, rectangles show original background colors (NOT white!)
7. Click "Export"

### Test 3: GPU Verification
1. Check the GPU status chip above "Rendering Method"
2. Should show: "✓ CUDA (device 0: NVIDIA GeForce RTX 3060)" or similar
3. Open Task Manager → Performance → GPU
4. Run Inpaint with LaMa/NewLaMa
5. **Expected**: NVIDIA GPU usage spikes to 80-100%

## Understanding LaMa Behavior

### Why You Might Still See Some White

LaMa inpaints based on **immediate surrounding context**:
- ✅ Text on white speech bubble → LaMa fills with white (CORRECT!)
- ✅ Text on brown dog → LaMa should fill with brown tones (CORRECT!)
- ✅ Text on colored background → LaMa fills with that color (CORRECT!)

**The key**: LaMa looks at the padding area (40-50px around text). If that padding is mostly white bubble, it fills with white. This is expected and correct behavior.

**After the fix**: When you use "+Backgrounds" (Process → Export), the colored rectangles will come from the ORIGINAL image colors, not LaMa's white fills.

### Workflow Comparison

**Rectangle Fill** (No AI):
```
Original image → Extract colors → Draw rectangles → Export
                 ↑ Colors from here
Fast, predictable, good for most cases
```

**LaMa AI** (High Quality):
```
Original image → LaMa inpaint → Textless plate
      ↓                              ↓
Extract colors                 Use as base canvas
      ↓                              ↓
      └──────→ Draw rectangles ──────┘ → Export

Colors from original, base from inpainted
Slower, uses GPU, higher quality for complex backgrounds
```

## Next Steps

1. **Build the app**: The fixes are in the code, need to compile
   ```powershell
   cd koharu
   bun tauri build -- --features cuda
   ```

2. **Test with real manga**: Use a page with varied backgrounds

3. **Report results**: Let me know if you still see white fills after Process

4. **GPU check**: Verify the GPU status indicator shows your NVIDIA card

## Expected Outcomes

✅ **Rectangle Fill**: Brown dog → brown rectangles, blue sky → blue rectangles, white bubble → white rectangles

✅ **LaMa Mode**: Textless plate (may have white bubbles) + colored rectangles from original backgrounds

✅ **GPU Status**: Clear indicator showing CUDA/DirectML/CPU with device name

❌ **Not Fixed**: If LaMa itself produces all-white inpainting during the Inpaint step, that's a different issue (model quality, padding, or detection masks)

## Build Warnings (Normal)

```
Info `tauri-build` dependency has workspace inheritance enabled...
```

**This is EXPECTED and NORMAL**. Tauri uses workspace dependencies, these info messages just explain that features are inherited from the workspace root. No action needed.

## Questions?

If you still see issues after testing:
1. Share which render method you used (Rectangle/LaMa/NewLaMa)
2. Share what stage showed white (Inpaint result vs final Export)
3. Share GPU status indicator output
4. Share Task Manager GPU usage during Inpaint
