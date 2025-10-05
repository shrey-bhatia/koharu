# Phase 3-4 Implementation Plan: Inpainting & Text Rendering

**Status**: Translation ✅ Complete | Inpainting & Rendering 🚧 In Progress

---

## Current State Analysis

### What We Have ✅

1. **Detection**: Finds text regions + generates segmentation mask
2. **OCR**: Extracts Japanese text from each region
3. **Translation**: Translates to English via Google Cloud API
4. **Inpainting Backend**: LaMa model ready to remove text
   - Input: Original image + mask (white = areas to inpaint)
   - Output: Cleaned image with text removed
   - Backend command exists: `inpaint(image, mask)`

### What's Missing ❌

1. **Segmentation mask not stored** - Detection returns it but we discard it
2. **No inpainting UI** - Can't trigger the backend from frontend
3. **No text rendering** - Can't draw translations onto cleaned image
4. **No export** - Can't save the final result

---

## The Correct Inpainting Pipeline

### How LaMa Works (AI Inpainting Model)

LaMa is a **content-aware** inpainting model specifically trained on manga/anime images. It:

✅ **Analyzes surrounding context** (background patterns, textures)
✅ **Intelligently fills** removed text areas with what "should" be there
✅ **Preserves artwork style** (screentones, gradients, line art)
✅ **Handles complex backgrounds** (not just "paint it white")

**Result**: Clean manga panel that looks like text was never there

### What You Get

```
Original:        After LaMa Inpainting:
┌─────────┐     ┌─────────┐
│ 日本語  │  →  │         │  (Intelligent fill based on context)
│ テキスト│     │         │  (Not just white - analyzes patterns)
└─────────┘     └─────────┘
```

**This is BETTER than trying to detect text color/background** because:
- LaMa was trained on 1000s of manga images
- Understands screentones, gradients, complex backgrounds
- Fills areas naturally (you won't see "paint bucket" artifacts)

---

## Implementation Strategy

### Phase 3: Inpainting (CORE FUNCTIONALITY)

**Goal**: Remove Japanese text from manga using existing segmentation mask

#### Task 3.1: Store Segmentation Mask ✅ CRITICAL

**Current Problem**: Detection returns mask but we throw it away

```typescript
// detection-panel.tsx currently does:
if (result?.bboxes) {
  setTextBlocks(result.bboxes)  // ✅ Stored
}
// result.segment is IGNORED ❌

// What we need:
if (result?.bboxes) {
  setTextBlocks(result.bboxes)
}
if (result?.segment) {
  setSegmentationMask(result.segment)  // Store the mask!
}
```

**Files to modify**:
- `next/lib/state.ts` - Add `segmentationMask: Uint8Array | null`
- `next/components/detection-panel.tsx` - Store mask from detection result

**Technical details**:
- Mask is 1024x1024 grayscale array (Vec<u8> from Rust)
- White pixels (255) = text areas detected
- Black pixels (0) = background

---

#### Task 3.2: Create Inpainting Panel ✅ CRITICAL

**UI Design**:

```
┌─────────────────────────────────┐
│ Inpainting                   [▶]│
├─────────────────────────────────┤
│ ℹ️  Removes text from image     │
│                                 │
│ Status: Ready to inpaint        │
│ Text regions detected: 12       │
│                                 │
│ [Run Inpainting]                │
└─────────────────────────────────┘
```

**Implementation**:

```typescript
// components/inpaint-panel.tsx
export default function InpaintPanel() {
  const { image, segmentationMask, setInpaintedImage } = useEditorStore()
  const [loading, setLoading] = useState(false)

  const runInpaint = async () => {
    if (!image || !segmentationMask) {
      alert('Run detection first')
      return
    }

    setLoading(true)

    // Convert image to buffer
    const imageBuffer = await imageBitmapToArrayBuffer(image.bitmap)

    // Create mask image (1024x1024 grayscale)
    const maskBuffer = createMaskBuffer(segmentationMask)

    // Call backend
    const result = await invoke<number[]>('inpaint', {
      image: Array.from(new Uint8Array(imageBuffer)),
      mask: Array.from(new Uint8Array(maskBuffer))
    })

    // Convert result back to ImageBitmap
    const inpainted = await createImageFromBuffer(new Uint8Array(result).buffer)
    setInpaintedImage(inpainted.bitmap)

    setLoading(false)
  }

  return (/* UI */)
}
```

**Helper needed**:
```typescript
// utils/image.ts
export function createMaskBuffer(mask: Uint8Array): ArrayBuffer {
  // Convert grayscale mask to PNG
  const canvas = new OffscreenCanvas(1024, 1024)
  const ctx = canvas.getContext('2d')

  const imageData = new ImageData(1024, 1024)
  for (let i = 0; i < mask.length; i++) {
    const val = mask[i]
    imageData.data[i * 4] = val      // R
    imageData.data[i * 4 + 1] = val  // G
    imageData.data[i * 4 + 2] = val  // B
    imageData.data[i * 4 + 3] = 255  // A
  }

  ctx.putImageData(imageData, 0, 0)
  return await canvas.convertToBlob().then(b => b.arrayBuffer())
}
```

**Files to create**:
- `next/components/inpaint-panel.tsx` (new)

**Files to modify**:
- `next/app/page.tsx` - Show inpaint panel when `tool === 'inpaint'`
- `next/lib/state.ts` - Add `inpaintedImage: ImageBitmap | null`
- `next/utils/image.ts` - Add `createMaskBuffer()` helper

---

#### Task 3.3: Display Inpainted Result ✅ CRITICAL

**Canvas layer**:
```typescript
// canvas.tsx
<Layer>
  {tool === 'inpaint' && inpaintedImage && (
    <Image image={inpaintedImage} />
  )}
</Layer>
```

**Testing**:
1. Load manga
2. Run Detection (stores mask automatically)
3. Click Inpaint tool
4. Click "Run Inpainting"
5. Wait ~5-10 seconds (LaMa is slow but worth it)
6. Verify text is cleanly removed

---

### Phase 4: Text Rendering (CORE FUNCTIONALITY)

**Goal**: Draw English translations onto inpainted manga

#### Task 4.1: Basic Text Rendering ✅ CRITICAL

**Approach**: Use Konva.js Text elements (already in project)

```typescript
// canvas.tsx - Add new layer
<Layer>
  {tool === 'translation' && textBlocks.map((block, i) => {
    if (!block.translatedText) return null

    return (
      <Text
        key={i}
        x={block.xmin}
        y={block.ymin}
        width={block.xmax - block.xmin}
        height={block.ymax - block.ymin}
        text={block.translatedText}
        fontSize={calculateFontSize(block)}
        fontFamily="Arial"  // Will make configurable later
        fill="black"
        align="center"
        verticalAlign="middle"
        wrap="word"
      />
    )
  })}
</Layer>
```

---

#### Task 4.2: Automatic Font Sizing ✅ CRITICAL

**The "Magic" Algorithm**:

```typescript
function calculateFontSize(block: TextBlock): number {
  const boxWidth = block.xmax - block.xmin
  const boxHeight = block.ymax - block.ymin
  const text = block.translatedText || ''

  // Heuristic: estimate characters per line
  const avgCharsPerLine = Math.floor(boxWidth / 8) // Assume 8px per char
  const estimatedLines = Math.ceil(text.length / avgCharsPerLine)

  // Calculate font size that fits
  const fontSizeByHeight = boxHeight / estimatedLines / 1.2  // 1.2 = line spacing
  const fontSizeByWidth = boxWidth / avgCharsPerLine * 1.5

  // Take the smaller (limiting factor)
  const fontSize = Math.min(fontSizeByHeight, fontSizeByWidth)

  // Constraints
  return Math.max(Math.min(fontSize, 48), 10) // Between 10-48px
}
```

**Testing priorities**:
1. Short text in large box → Should be readable
2. Long text in small box → Should shrink to fit
3. Very long text → Should wrap, not overflow

---

#### Task 4.3: Text Color Detection 💡 NICE-TO-HAVE (Phase 5)

**Why deferred**:
- Detection model already gives us black text vs white text (`class` field)
- `class: 0` = black text, `class: 1` = white text
- Good enough for 95% of manga

**Simple implementation**:
```typescript
const textColor = block.class === 0 ? 'black' : 'white'
const outlineColor = block.class === 0 ? 'white' : 'black'

<Text
  fill={textColor}
  stroke={outlineColor}
  strokeWidth={1}
  // ... other props
/>
```

**Advanced (future)**:
- Sample colors from bounding box corners
- Detect speech bubble background color
- Use contrasting text color

---

#### Task 4.4: Manual Text Editing ✅ IMPORTANT

**UI Design**:

```
Translation Panel:
┌─────────────────────────────────┐
│ #1  [Badge]                     │
│ Original: こんにちは            │
│ Translation: [Hello_____] [✏️] │  ← Editable!
└─────────────────────────────────┘
```

**Implementation**:

```typescript
// translation-panel.tsx
const [editingIndex, setEditingIndex] = useState<number | null>(null)

{textBlocks.map((block, i) => (
  <div key={i}>
    {block.translatedText && (
      editingIndex === i ? (
        <TextArea
          value={block.translatedText}
          onChange={(e) => {
            const updated = [...textBlocks]
            updated[i] = { ...block, translatedText: e.target.value }
            setTextBlocks(updated)
          }}
          onBlur={() => setEditingIndex(null)}
        />
      ) : (
        <div onClick={() => setEditingIndex(i)}>
          <Text>{block.translatedText}</Text>
          <Button size="1">✏️ Edit</Button>
        </div>
      )
    )}
  </div>
))}
```

**Why this matters**:
- Translations aren't perfect
- User might want different phrasing
- Names/terms might need correction

---

#### Task 4.5: Export Final Result ✅ CRITICAL

**Goal**: Flatten all layers and save as image

```typescript
// components/export-panel.tsx (new)
export default function ExportPanel() {
  const { image, inpaintedImage, textBlocks } = useEditorStore()

  const exportImage = async () => {
    // Get canvas stage
    const stage = canvasRef.current

    // Temporarily show all layers
    // (inpainted image + translated text)

    // Export as data URL
    const dataUrl = stage.toDataURL({ pixelRatio: 2 })

    // Trigger download
    const link = document.createElement('a')
    link.download = 'translated_manga.png'
    link.href = dataUrl
    link.click()
  }

  return (
    <Button onClick={exportImage}>
      Export Translated Image
    </Button>
  )
}
```

---

## Phase 5: Polish & Advanced Features (FUTURE)

### 5.1: Font Selection 💎 ENHANCEMENT

**UI Addition**:
```typescript
// settings-dialog.tsx - Add font picker
<Select value={selectedFont} onChange={setFont}>
  <option value="Arial">Arial</option>
  <option value="Comic Sans MS">Comic Sans MS</option>
  <option value="Manga Temple">Manga Temple</option>
  <option value="Wild Words">Wild Words</option>
</Select>
```

**Implementation**:
- Store `fontFamily: string` in state
- Apply to all Text elements
- Consider bundling manga-specific fonts

**Nice fonts for manga**:
- Wild Words (classic comic)
- Anime Ace (manga style)
- Komika (playful)

---

### 5.2: Manual Text Adjustment 💎 ENHANCEMENT

**Interactive editing**:
```typescript
// Make text boxes draggable and resizable
<Text
  draggable
  onDragEnd={(e) => {
    // Update block position
    const updated = [...textBlocks]
    updated[i] = { ...block, xmin: e.target.x(), ymin: e.target.y() }
    setTextBlocks(updated)
  }}
/>

{selected && <Transformer nodes={[selected]} />}
```

**Use cases**:
- Text doesn't fit perfectly
- User wants to reposition
- Multi-line wrapping needs adjustment

---

### 5.3: Background Color Matching 💎 ENHANCEMENT

**Goal**: Match speech bubble background instead of pure white/black

```typescript
function detectBackgroundColor(
  image: ImageBitmap,
  bbox: BoundingBox
): string {
  // Sample pixels from corners of bounding box
  const corners = [
    getPixel(bbox.xmin, bbox.ymin),
    getPixel(bbox.xmax, bbox.ymin),
    getPixel(bbox.xmin, bbox.ymax),
    getPixel(bbox.xmax, bbox.ymax),
  ]

  // Average colors
  const avgColor = averageColors(corners)
  return rgbToHex(avgColor)
}
```

**Then use for text fill color contrast**

---

### 5.4: Batch Processing 💎 ENHANCEMENT

**Goal**: Translate multiple manga pages at once

```typescript
// Load folder of images
// Process each: Detection → OCR → Translation → Inpaint → Render
// Export all to output folder
```

**UI**: Progress bar showing "Processing page 3/25..."

---

## Implementation Priority

### Phase 3 (NEXT - Core Inpainting)
**Time estimate**: 3-4 hours

1. ✅ Store segmentation mask from detection
2. ✅ Create inpaint panel UI
3. ✅ Call inpaint backend command
4. ✅ Display inpainted result on canvas
5. ✅ Test with real manga

### Phase 4 (Core Text Rendering)
**Time estimate**: 4-5 hours

1. ✅ Render translated text on canvas
2. ✅ Implement auto font sizing
3. ✅ Use text color from detection class
4. ✅ Add manual text editing in panel
5. ✅ Implement export functionality
6. ✅ Test complete pipeline

### Phase 5 (Polish)
**Time estimate**: 5-7 hours (future work)

1. 💎 Font selector dropdown
2. 💎 Draggable/resizable text boxes
3. 💎 Background color detection
4. 💎 Batch processing
5. 💎 Keyboard shortcuts
6. 💎 Undo/redo

---

## Testing Plan

### Full Pipeline Test

1. **Load manga page**
2. **Detection** → Should see red boxes + mask stored
3. **OCR** → Should see Japanese text
4. **Translation** → Should see English translations
5. **Inpaint** → Should see clean manga (text removed)
6. **View translations rendered** → Text appears in boxes
7. **Edit translation** → Click to modify text
8. **Export** → Download final translated image

### Edge Cases to Test

- Very small text boxes (< 20px)
- Very large text boxes (> 200px)
- Long translations that need wrapping
- Short translations (single word)
- Mixed black/white text in same image
- Complex backgrounds (gradients, patterns)

---

## File Checklist

### New Files Needed

- [ ] `next/components/inpaint-panel.tsx`
- [ ] `next/components/export-panel.tsx`
- [ ] `next/utils/text-rendering.ts` (font sizing logic)

### Files to Modify

- [ ] `next/lib/state.ts` (add segmentationMask, inpaintedImage)
- [ ] `next/components/detection-panel.tsx` (store mask)
- [ ] `next/components/canvas.tsx` (add text rendering layer)
- [ ] `next/components/translation-panel.tsx` (add edit functionality)
- [ ] `next/app/page.tsx` (show inpaint panel)
- [ ] `next/utils/image.ts` (add createMaskBuffer)

---

## Success Criteria

**Phase 3 Complete** when:
- ✅ Inpainting removes text cleanly
- ✅ LaMa fills areas intelligently (not just white)
- ✅ Inpainted image displays on canvas
- ✅ No artifacts or errors

**Phase 4 Complete** when:
- ✅ Translations render on image
- ✅ Text auto-sizes to fit boxes
- ✅ Can edit translations before rendering
- ✅ Can export final image
- ✅ Quality is publication-ready

**Phase 5** (nice-to-have):
- 💎 Font selection works
- 💎 Text boxes are draggable
- 💎 Batch processing works
- 💎 Professional quality output

---

## Notes

**Why LaMa is Perfect for This**:
- Trained specifically on manga/anime images
- Understands screentones (those dots manga uses for shading)
- Handles complex patterns (speed lines, backgrounds)
- Much better than "paint it white"

**Don't Overthink It**:
- Detection already tells us text color (class field)
- LaMa handles background inpainting better than we could manually
- Focus on making the core pipeline bulletproof first
- Polish features can come later

**Critical Path**:
Store mask → Inpaint → Render text → Export
Everything else is bonus polish.
