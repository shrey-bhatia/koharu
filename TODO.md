# Koharu Development Roadmap

## Project Goal
Complete the manga translation pipeline to enable automatic Japanese→English manga translation with text removal and rendering.

---

## Current Status (2025-10-04)

### ✅ Working Features
- [x] Text detection (bounding boxes)
- [x] OCR (Japanese text extraction)
- [x] CUDA acceleration
- [x] Basic UI and canvas rendering

### ❌ Missing Features
- [ ] Segmentation mask display
- [ ] Translation (LLM/API integration)
- [ ] Inpainting UI
- [ ] Text rendering on inpainted image
- [ ] Export functionality

---

## Development Phases

### Phase 1: Segmentation Visualization (NEXT UP)

**Goal**: Display the segmentation mask from detection

**Tasks**:
1. [ ] Add `segmentationMask` to state
   - Type: `ImageData | null`
   - Stores 1024x1024 grayscale mask from detection

2. [ ] Update detection panel to store mask
   ```typescript
   // detection-panel.tsx
   if (result?.segment) {
     const maskImageData = createImageDataFromBuffer(result.segment, 1024, 1024)
     setSegmentationMask(maskImageData)
   }
   ```

3. [ ] Add helper function to convert mask
   ```typescript
   // utils/image.ts
   export function createImageDataFromBuffer(
     buffer: number[],
     width: number,
     height: number
   ): ImageData {
     const data = new Uint8ClampedArray(width * height * 4)
     for (let i = 0; i < buffer.length; i++) {
       data[i * 4] = buffer[i]     // R
       data[i * 4 + 1] = buffer[i] // G
       data[i * 4 + 2] = buffer[i] // B
       data[i * 4 + 3] = 128       // Semi-transparent
     }
     return new ImageData(data, width, height)
   }
   ```

4. [ ] Render mask on canvas
   ```typescript
   // canvas.tsx
   <Layer>
     {tool === 'segmentation' && segmentationMask && (
       <Image image={createImageBitmapFromImageData(segmentationMask)} />
     )}
   </Layer>
   ```

5. [ ] Test segmentation view
   - Run detection
   - Click segmentation tool
   - Verify white overlay appears on text regions

**Files to modify**:
- `next/lib/state.ts`
- `next/components/detection-panel.tsx`
- `next/components/canvas.tsx`
- `next/utils/image.ts`

**Time estimate**: 1-2 hours

---

### Phase 2: Translation Implementation

**Goal**: Translate OCR'd Japanese text to English using LLM API

**Decision Point: Choose Translation Method**

#### Option A: Google Cloud Translation API (RECOMMENDED)
**Pros**:
- Free 500k chars/month
- Neural machine translation (NMT)
- Domain-specific models available
- Fast, reliable, no rate limits in free tier
- Simple REST API

**Cons**:
- Requires Google Cloud account
- Less "natural" than GPT-4 for context-aware translation

**Implementation**:
```typescript
const response = await fetch(
  'https://translation.googleapis.com/language/translate/v2',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: japaneseText,
      source: 'ja',
      target: 'en',
      key: apiKey,
    }),
  }
)
```

#### Option B: Google Gemini API
**Pros**:
- Free tier (generous)
- Good at context-aware translation
- Can use system prompts for style
- You already have access

**Cons**:
- Rate limits (15 RPM free tier)
- Slower than Cloud Translation
- Overkill for simple translation

**Implementation**:
```typescript
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: `Translate to English: ${japaneseText}` }]
      }]
    })
  }
)
```

#### Option C: Local Translation Model
**Pros**:
- No API costs
- Works offline
- No rate limits

**Cons**:
- Requires bundling large model (~500MB+)
- Slower than cloud APIs
- Lower quality than GPT-4/Gemini
- Adds complexity to build

**Not recommended** unless offline support is critical.

---

### Phase 2 Tasks (After Choosing API)

1. [ ] Add API configuration to state
   ```typescript
   // state.ts
   type Config = {
     translationApiKey: string
     translationProvider: 'google-cloud' | 'gemini' | 'openai'
     systemPrompt: string
   }
   ```

2. [ ] Create settings panel for API key input
   - Add "Settings" button to topbar
   - Modal dialog for entering API key
   - Save to localStorage (encrypted if possible)
   - Test connection button

3. [ ] Implement translation function
   ```typescript
   // utils/translation.ts
   export async function translateText(
     text: string,
     provider: string,
     apiKey: string,
     systemPrompt?: string
   ): Promise<string> {
     // Call chosen API
   }
   ```

4. [ ] Update translation panel
   ```typescript
   const translate = async () => {
     setLoading(true)
     const updated = await Promise.all(
       textBlocks.map(async (block) => {
         if (!block.text) return block
         const translated = await translateText(
           block.text,
           config.provider,
           config.apiKey
         )
         return { ...block, translatedText: translated }
       })
     )
     setTextBlocks(updated)
     setLoading(false)
   }
   ```

5. [ ] Add progress indicator
   - Show "Translating block X/Y"
   - Handle rate limits with delays
   - Retry on failure

6. [ ] Test translation
   - Verify translations appear in panel
   - Check error handling for invalid API key
   - Test with multiple text blocks

**Files to create/modify**:
- `next/utils/translation.ts` (new)
- `next/components/translation-panel.tsx`
- `next/components/settings-panel.tsx` (new)
- `next/lib/state.ts`

**Time estimate**: 3-4 hours

---

### Phase 3: Inpainting UI

**Goal**: Remove original Japanese text from manga using LaMa model

1. [ ] Create inpaint panel component
   ```typescript
   // components/inpaint-panel.tsx
   export default function InpaintPanel() {
     const { image, segmentationMask, setInpaintedImage } = useEditorStore()

     const runInpaint = async () => {
       const imageBuffer = await imageBitmapToArrayBuffer(image.bitmap)
       const maskBuffer = segmentationMaskToBuffer(segmentationMask)

       const result = await invoke<number[]>('inpaint', {
         image: Array.from(new Uint8Array(imageBuffer)),
         mask: Array.from(new Uint8Array(maskBuffer))
       })

       const inpainted = await createImageFromBuffer(new Uint8Array(result).buffer)
       setInpaintedImage(inpainted.bitmap)
     }

     return (
       <div>
         <h2>Inpaint</h2>
         <Button onClick={runInpaint}>Remove Text</Button>
       </div>
     )
   }
   ```

2. [ ] Add inpainted image to state
   ```typescript
   // state.ts
   const store = {
     inpaintedImage: null as ImageBitmap | null,
     setInpaintedImage: (img: ImageBitmap | null) => set({ inpaintedImage: img })
   }
   ```

3. [ ] Render inpainted image on canvas
   ```typescript
   // canvas.tsx
   <Layer ref={inpaintLayerRef}>
     {tool === 'inpaint' && inpaintedImage && (
       <Image image={inpaintedImage} />
     )}
   </Layer>
   ```

4. [ ] Update page.tsx to show inpaint panel
   ```typescript
   {selectedTool === 'inpaint' && <InpaintPanel />}
   ```

5. [ ] Test inpainting
   - Run detection → segmentation → inpaint
   - Verify text is removed cleanly
   - Check performance (may take 5-10 seconds)

**Files to create/modify**:
- `next/components/inpaint-panel.tsx` (new)
- `next/app/page.tsx`
- `next/components/canvas.tsx`
- `next/lib/state.ts`

**Time estimate**: 2-3 hours

---

### Phase 4: Text Rendering

**Goal**: Draw translated English text onto inpainted manga

**Challenges**:
- Font sizing to fit bounding boxes
- Text wrapping if translation is longer
- Font selection (manga-appropriate)
- Vertical vs horizontal text
- Text positioning/alignment

**Tasks**:

1. [ ] Add text rendering layer to canvas
   ```typescript
   // canvas.tsx
   <Layer>
     {textBlocks.map((block, i) => (
       block.translatedText && (
         <Text
           key={i}
           x={block.xmin}
           y={block.ymin}
           width={block.xmax - block.xmin}
           height={block.ymax - block.ymin}
           text={block.translatedText}
           fontSize={calculateFontSize(block)}
           fontFamily="Arial"
           fill="black"
           align="center"
           verticalAlign="middle"
         />
       )
     ))}
   </Layer>
   ```

2. [ ] Implement font size calculation
   ```typescript
   function calculateFontSize(block: TextBlock): number {
     const boxWidth = block.xmax - block.xmin
     const boxHeight = block.ymax - block.ymin
     const textLength = block.translatedText?.length || 0

     // Heuristic: fit text in box
     const fontSize = Math.min(
       boxHeight / 2,
       boxWidth / (textLength * 0.6)
     )
     return Math.max(fontSize, 12) // Minimum readable size
   }
   ```

3. [ ] Add manual text adjustment
   - Drag text boxes to reposition
   - Resize boxes with handles
   - Edit translations inline
   - Change font/size/color

4. [ ] Handle edge cases
   - Very long translations (text wrapping)
   - Small text boxes (abbreviate or overflow)
   - Vertical text (rotate rendering)

5. [ ] Test rendering
   - Verify text fits in boxes
   - Check readability
   - Test with various manga styles

**Files to modify**:
- `next/components/canvas.tsx`
- `next/utils/text-rendering.ts` (new)

**Time estimate**: 4-5 hours

---

### Phase 5: Export & Polish

**Goal**: Save translated manga and improve UX

1. [ ] Add export functionality
   - Flatten all canvas layers
   - Export as PNG/JPG
   - Save to user-selected location

2. [ ] Add batch processing
   - Load multiple pages
   - Run full pipeline on each
   - Export as folder/ZIP

3. [ ] Improve UI/UX
   - Loading states for slow operations
   - Error messages for failures
   - Keyboard shortcuts
   - Undo/redo

4. [ ] Performance optimization
   - Parallel OCR (process multiple blocks at once)
   - Cache results (don't re-run if image unchanged)
   - Optimize canvas rendering

5. [ ] User settings
   - Default thresholds
   - Preferred translation style
   - Output format/quality

**Time estimate**: 5-7 hours

---

## Recommended Immediate Next Steps

### Step 1: Choose Translation API (DECISION NEEDED)

**My Recommendation**: Google Cloud Translation API

**Reasons**:
1. Free 500k chars/month (plenty for personal use)
2. Fast and reliable
3. No rate limits in free tier
4. Simple REST API
5. Good quality for manga translation

**Alternative**: Gemini 2.0 Flash if you prefer LLM-style translation with more context awareness

### Step 2: Start Phase 1 (Segmentation)

This is low-risk and will verify the detection mask is working correctly.

### Step 3: Implement Translation (Phase 2)

Once you decide on API, implement translation next since it's independent of inpainting.

### Step 4: Build Remaining Phases

After translation works, tackle inpainting and text rendering in order.

---

## Build Time Optimization Notes

### Current Build Time: ~3-7 minutes

**Why**:
1. Rust compilation with large dependencies (2-3 min)
2. CUDA bindings compile C++ (1-2 min)
3. LTO (Link-Time Optimization) (1-2 min)
4. Frontend Next.js build (30-60 sec)
5. Installer packaging (30 sec)

### Optimization Options

#### Option 1: Use `--no-bundle` for testing
```bash
bun tauri build -- --features=cuda --no-bundle
# Skips MSI/NSIS creation, saves ~30 seconds
```

#### Option 2: Install sccache (Rust compilation cache)
```bash
cargo install sccache

# Add to ~/.cargo/config.toml
[build]
rustc-wrapper = "sccache"
```
**Benefit**: Incremental builds drop from 3min → 30sec

#### Option 3: Separate frontend/backend workflows
```bash
# When only changing frontend
cd next && bun run build
# Then run dev mode
bun tauri dev
```

#### Option 4: Temporarily disable LTO
```toml
# Cargo.toml (DON'T COMMIT THIS)
[profile.release]
lto = false  # Faster build, ~20% larger binary
```

### What NOT to Do
- ❌ Remove dependencies (breaks functionality)
- ❌ Disable CUDA features (defeats purpose)
- ❌ Use debug builds for testing (10x slower runtime)

### Recommended Approach
- Use `bun tauri dev` for rapid iteration (hot reload)
- Only do full builds when testing the complete pipeline
- Install `sccache` for faster incremental builds

---

## Maintenance & Handoff

### Before Starting New Work
1. Pull latest changes: `git pull`
2. Read PIPELINE.md for current status
3. Read this TODO.md for assigned tasks
4. Check commit log: `git log --oneline -10`

### After Completing Work
1. Test thoroughly (see AGENTS.md)
2. Update PIPELINE.md with implementation status
3. Update this TODO.md:
   - Mark tasks complete: `- [x]`
   - Add notes on what was done
   - Update time estimates if way off
4. Commit with clear message
5. Document any blockers or issues

### Handing Off to Next Developer/Agent
Add section to this file:
```markdown
## Latest Work Session (DATE)

### What I Did
- Implemented X
- Fixed Y
- Started Z but didn't finish because...

### What's Left
- Next task: ...
- Blocker: ...
- Suggestion: ...
```

---

## Questions & Decisions

### Translation API Choice
**Status**: ⏳ PENDING DECISION

**Options**:
- A) Google Cloud Translation API (recommended)
- B) Google Gemini API
- C) OpenAI GPT-4o
- D) Local translation model

**Decision needed by**: Before starting Phase 2

---

### Text Rendering Approach
**Status**: 🔮 Future consideration

**Options**:
- A) Canvas-based (Konva Text elements)
- B) HTML overlay (absolute positioned divs)
- C) Hybrid (edit in HTML, render in canvas for export)

**Decision needed by**: Before starting Phase 4

---

## Resources & References

- [PIPELINE.md](./PIPELINE.md) - Technical deep-dive
- [AGENTS.md](./AGENTS.md) - Coding guidelines
- [README.md](./README.md) - User documentation
- [Tauri Docs](https://tauri.app/v2/)
- [Google Cloud Translation](https://cloud.google.com/translate)
- [Gemini API](https://ai.google.dev/)

---

**Last Updated**: 2025-10-04
**Next Review**: After Phase 1 completion
