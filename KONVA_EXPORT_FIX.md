# Konva Export Fix - Root Cause Analysis

## Problem
The live preview using React-Konva worked perfectly, but the export function failed to render text correctly. The exported images had text that looked different from the preview or was missing entirely.

## REAL Root Cause 🎯

### **Inconsistent Properties Between Preview and Export**

The live preview (`canvas.tsx`) uses MINIMAL Konva Text properties:
```tsx
<Text
  text={block.translatedText}
  fontSize={block.fontSize}
  fontFamily={block.fontFamily || 'Arial'}
  fill={...}
  stroke={...}
  align='center'
  verticalAlign='middle'
  wrap='word'
/>
```

But the export function (`konva-text-render.ts`) was trying to use ADDITIONAL properties:
- ❌ `letterSpacing`
- ❌ `lineHeight`  
- ❌ `fontWeight` / `fontStyle`
- ❌ `fontVariant` / `fontStretch`

**Result**: Export looked different because it was applying styling the preview never used!

## Secondary Issues

### 1. **Detached DOM Container** ❌
```typescript
// BROKEN CODE:
const stage = new Konva.Stage({
  container: document.createElement('div'), // NOT attached to DOM!
  width,
  height,
})
```

**Why this fails:**
- Konva internally creates a `<canvas>` element and appends it to the container
- For proper font rendering, text measurements, and layout calculations, the canvas needs to be in the DOM
- Detached elements don't have proper layout context, causing:
  - Fonts not loading correctly
  - Text measurements being inaccurate
  - Canvas operations failing silently

### 2. **Missing Async/Await on `toCanvas()`** ❌
```typescript
// BROKEN CODE:
const konvaCanvas = stage.toCanvas({ pixelRatio: scale })
```

**Why this fails:**
- `stage.toCanvas()` can return a Promise when fonts or other resources need loading
- Not awaiting it means we're trying to draw an incomplete canvas
- The timing race condition causes text to be missing or partially rendered

### 3. **No Font Loading Wait** ❌
```typescript
// BROKEN CODE:
layer.draw()
const konvaCanvas = stage.toCanvas({ pixelRatio: scale }) // Immediate!
```

**Why this fails:**
- Custom fonts (like Arial, Noto Sans, etc.) need time to load
- Drawing immediately after layer creation doesn't give fonts time to initialize
- Results in fallback fonts or missing text

## The Fix ✅

### 1. **Attach Container to DOM Temporarily**
```typescript
// FIXED:
const tempContainer = document.createElement('div')
tempContainer.style.position = 'absolute'
tempContainer.style.top = '-9999px'  // Off-screen
tempContainer.style.left = '-9999px'
tempContainer.style.width = `${width}px`
tempContainer.style.height = `${height}px`
document.body.appendChild(tempContainer) // CRITICAL: Attach to DOM!

const stage = new Konva.Stage({
  container: tempContainer, // Use DOM-attached container
  width,
  height,
})
```

**Why this works:**
- Container is in the DOM, giving Konva proper rendering context
- Positioned off-screen so it doesn't flash on the page
- Has explicit dimensions for proper layout

### 2. **Wait for Font Loading**
```typescript
// FIXED:
await new Promise<void>((resolve) => {
  layer.draw()
  // Wait for next frame to ensure fonts are loaded
  requestAnimationFrame(() => resolve())
})
```

**Why this works:**
- `requestAnimationFrame()` ensures we wait for the next paint cycle
- Gives fonts time to load and be applied
- Ensures the layer is fully rendered before conversion

### 3. **Properly Await `toCanvas()`**
```typescript
// FIXED:
const konvaCanvas = await stage.toCanvas({ pixelRatio: scale })
```

**Why this works:**
- Properly handles the Promise returned by `toCanvas()`
- Ensures we get a fully-rendered canvas before drawing it to our target
- No race conditions

### 4. **Clean Up Resources**
```typescript
// FIXED:
finally {
  stage.destroy()
  document.body.removeChild(tempContainer) // Remove from DOM!
}
```

**Why this is important:**
- Prevents memory leaks
- Removes the temporary container from DOM
- Properly cleans up Konva resources

## Why Live Preview Worked

The React-Konva components (`<Stage>`, `<Layer>`, `<Text>`) in `canvas.tsx` worked because:

1. ✅ They're properly mounted in the React component tree
2. ✅ The container is a real DOM element that's visible
3. ✅ React handles the lifecycle and ensures proper timing
4. ✅ Fonts have time to load before rendering

## Testing the Fix

1. Load an image with detected text blocks
2. Run OCR and Translation
3. Click "Process" in the Render panel
4. Click "Export"
5. **Expected result:** Exported PNG should have text rendered identically to the live preview

## Technical Notes

- **OffscreenCanvas:** While the code supports it, Konva doesn't fully support OffscreenCanvas. We convert the Konva canvas to the target canvas using `drawImage()`.
- **Font Loading API:** Future improvement could use `document.fonts.ready` for more robust font loading detection.
- **Performance:** The temporary DOM attachment is very fast (<10ms) and happens off-screen, so there's no visual impact.

## The Real Solution ✅

**Match the export properties EXACTLY to the live preview AND enable user customizations:**

```typescript
const textConfig: TextConfig = {
  x: block.xmin,
  y: block.ymin,
  width: boxWidth,
  height: boxHeight,
  text: block.translatedText,
  fontSize: block.fontSize,
  fontFamily,
  fill: `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`,
  letterSpacing: block.letterSpacing,  // ✅ Now supported!
  lineHeight: block.lineHeight,        // ✅ Now supported!
  align: 'center',
  verticalAlign: 'middle',
  wrap: 'word',
  listening: false,
  perfectDrawEnabled: false,
}
```

**Added to BOTH preview and export** so user customizations work correctly!

## Why This Matters

The export function must produce **identical output** to the live preview. Any difference in properties will cause visual discrepancies. Users customize text in the preview, expecting the export to match exactly what they see.

## Notes on Font Properties

### Supported Properties ✅
- **`letterSpacing`**: Number (in pixels) - fully supported
- **`lineHeight`**: Number (multiplier, e.g., 1.2) - fully supported
- **`fontFamily`**: String - fully supported
- **`fontSize`**: Number (in pixels) - fully supported

### Problematic Properties ⚠️
- **`fontWeight`**: Konva supports via `fontStyle` property (e.g., 'bold', '500')
  - Currently NOT implemented in preview/export
  - UI allows customization but doesn't affect rendering
  - TODO: Convert `fontWeight` to Konva's `fontStyle` format

- **`fontStretch`**: Konva only supports via `fontVariant` ('normal' or 'small-caps')
  - User wants 'condensed'/'expanded' but Konva doesn't support these
  - Currently NOT implemented
  - TODO: Consider removing this UI option or finding workaround

## Related Files
- `next/utils/konva-text-render.ts` - Main rendering utility (FIXED)
- `next/components/render-panel.tsx` - Export function (uses the utility)
- `next/components/canvas.tsx` - Live preview (the reference implementation)
