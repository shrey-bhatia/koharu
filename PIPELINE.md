# Koharu Translation Pipeline Documentation

## Current Implementation Status (As of 2025-10-04)

### Overview
Koharu is a manga translation application that uses AI models to detect, OCR, and translate Japanese manga. The project was **partially completed** by the original developer and has been continued by the community.

---

## Architecture

### Tech Stack
- **Backend**: Rust + Tauri 2.x
- **Frontend**: React + Next.js 15 + TypeScript
- **State Management**: Zustand
- **Canvas Rendering**: react-konva (Konva.js)
- **AI Runtime**: ONNX Runtime with CUDA support
- **Package Manager**: Bun

### Backend Models (All ONNX, Downloaded from HuggingFace)

1. **comic-text-detector** (`mayocream/comic-text-detector-onnx`)
   - Detects text regions in manga images
   - Returns bounding boxes + segmentation mask
   - Input: 1024x1024 RGB image
   - Output: Bboxes (xmin, ymin, xmax, ymax, confidence, class) + 1024x1024 grayscale mask

2. **manga-ocr** (`mayocream/manga-ocr-onnx`)
   - Extracts Japanese text from cropped regions
   - Encoder-decoder architecture
   - Input: 224x224 grayscale image
   - Output: Japanese text string

3. **lama-manga** (`mayocream/lama-manga-onnx`)
   - Inpaints (removes) text from images
   - Based on LaMa (Large Mask Inpainting)
   - Input: 512x512 image + mask (white=inpaint area)
   - Output: Inpainted image with text removed

---

## Pipeline Stages

### ✅ Stage 1: Detection (WORKING)

**Location**: `src-tauri/src/commands.rs::detection()`

**Flow**:
1. User loads manga image via file picker
2. Frontend sends full image buffer to backend
3. Backend resizes to 1024x1024 and runs comic-text-detector model
4. Returns:
   - `bboxes`: Array of detected text regions with coordinates
   - `segment`: 1024x1024 binary mask (white pixels = text areas)

**Frontend State**:
- Stores `bboxes` in `textBlocks` state
- ⚠️ **ISSUE**: `segment` mask is currently discarded (not stored)

**UI Elements**:
- Detection panel with confidence/NMS threshold sliders
- Shows count of detected text blocks
- Canvas renders red bounding boxes with numbered circles

---

### ✅ Stage 2: OCR (WORKING)

**Location**: `src-tauri/src/commands.rs::ocr()`

**Flow**:
1. For each detected text block:
   - Frontend crops region from main image using bounding box coords
   - Converts ImageBitmap → PNG ArrayBuffer
   - Sends to backend
2. Backend resizes to 224x224 and runs manga-ocr model
3. Returns Japanese text string
4. Frontend updates `textBlocks[i].text` with OCR result

**Frontend State**:
- Each `TextBlock` gains optional `text?: string` field
- OCR panel displays numbered list of detected text

**Known Issues**:
- OCR processes sequentially (can be slow for many blocks)
- No error handling for invalid crop regions

---

### ❌ Stage 3: Segmentation Viewing (NOT IMPLEMENTED)

**Intended Purpose**: Visualize the segmentation mask overlay

**Current State**:
- Tool button exists in sidebar
- Canvas has `<Layer>{tool === 'segmentation' && <Image image={null} />}</Layer>`
- **MISSING**:
  - No state to store segment mask
  - No code to convert Vec<u8> → ImageBitmap
  - No UI to display mask overlay

**What Needs to be Done**:
1. Store `segment` from detection result in state
2. Convert 1024x1024 grayscale buffer to ImageBitmap
3. Render as semi-transparent overlay on canvas

---

### ❌ Stage 4: Translation (NOT IMPLEMENTED)

**Location**: `next/components/translation-panel.tsx`

**Current State**:
```typescript
const translate = async () => {
  // TODO: Implement translation logic
}
```

**Intended Flow**:
1. User enters system prompt (e.g., "Translate Japanese to English")
2. Click "Run Translation" button
3. For each text block with OCR'd text:
   - Send to LLM API (OpenAI/Anthropic/Gemini/etc)
   - Receive English translation
   - Store in `textBlocks[i].translatedText`
4. Display translations in scrollable list

**Design Decisions Needed**:
- **API Choice**: OpenAI GPT-4o / Anthropic Claude / Google Gemini / Google Cloud Translation
- **Local vs Cloud**: Cloud API (free tier) vs bundled local model
- **API Key Management**: Environment variable vs UI input field vs config file
- **Batch vs Sequential**: Send all at once or one-by-one

---

### ❌ Stage 5: Inpainting (BACKEND ONLY)

**Location**: `src-tauri/src/commands.rs::inpaint()`

**Backend Status**: ✅ Fully implemented
- Takes full image + mask → Returns inpainted image

**Frontend Status**: ❌ No UI
- No panel/button to trigger inpainting
- No state to store inpainted result
- No canvas layer to display result

**What Needs to be Done**:
1. Create inpaint panel component
2. Add "Run Inpaint" button
3. Convert segmentation mask to format LaMa expects
4. Store inpainted image in state
5. Render on canvas when in "inpaint" tool mode

---

### ❌ Stage 6: Translation Rendering (NOT IMPLEMENTED)

**Purpose**: Draw translated English text onto the inpainted image

**Current State**: Completely missing

**What Needs to be Done**:
1. After inpainting, for each text block:
   - Calculate font size to fit bounding box
   - Choose appropriate font/style for manga
   - Handle text wrapping if translation is longer
   - Render text onto canvas at correct position
2. Allow manual adjustment of text boxes (resize/move)
3. Export final translated manga page

---

## State Management

### Current Zustand Store (`lib/state.ts`)

```typescript
type TextBlock = {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
  confidence: number
  class: number
  text?: string          // Added for OCR results
}

const store = {
  image: Image | null           // Loaded manga image
  textBlocks: TextBlock[]       // Detection results + OCR text
  tool: string                  // 'detection' | 'segmentation' | 'inpaint' | 'translation'
  scale: number                 // Canvas zoom level
}
```

### Missing State Fields

```typescript
// Needs to be added:
type TextBlock = {
  // ... existing fields
  text?: string              // ✅ Added
  translatedText?: string    // ❌ TODO: Translation results
}

const store = {
  // ... existing fields
  segmentationMask?: ImageBitmap   // ❌ TODO: Mask from detection
  inpaintedImage?: ImageBitmap     // ❌ TODO: Result from inpainting
}
```

---

## Build System

### Current Build Process

```bash
# Development (hot reload)
bun tauri dev

# Production build (CUDA-enabled)
bun tauri build -- --features=cuda
```

**Build Time**: ~3-7 minutes for full release build

**Why So Long?**
1. **Rust compilation**: Large dependency tree (ort, candle, image processing)
2. **ONNX Runtime**: Heavy C++ library with CUDA bindings
3. **LTO enabled**: `lto = true` in release profile (link-time optimization)
4. **Frontend**: Next.js production build + optimization

**Optimization Options** (see notes at bottom):
- Incremental builds (already enabled in dev profile)
- `sccache` for Rust compilation caching
- Separate frontend/backend builds
- Use `--no-bundle` flag for testing (skips MSI/NSIS creation)

---

## Dependencies & Models

### HuggingFace Model Cache
**Location**: `%USERPROFILE%\.cache\huggingface\hub\`

Models downloaded on first run:
- `models--mayocream--comic-text-detector-onnx` (~50MB)
- `models--mayocream--manga-ocr-onnx` (~150MB encoder + decoder + vocab)
- `models--mayocream--lama-manga-onnx` (~200MB)

### CUDA Requirements
- CUDA Toolkit 12.9
- cuDNN 9.11
- Paths in system PATH:
  - `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin`
  - `C:\Program Files\NVIDIA\CUDNN\v9.11\bin\12.9`

---

## Testing Workflow

### Manual Test Sequence

1. **Test Detection**:
   - Load manga image (PNG/JPG)
   - Click chat icon (detection tool)
   - Adjust thresholds (default 0.5 is good)
   - Click Play button
   - ✅ Verify: Red boxes appear, count updates

2. **Test OCR**:
   - After detection, click Play in OCR panel
   - ✅ Verify: Japanese text appears in numbered list
   - Check browser console for errors

3. **Test Translation** (not implemented):
   - Currently does nothing
   - Check `translation-panel.tsx:13` for TODO comment

4. **Test Inpainting** (no UI):
   - Backend command exists but no way to trigger from UI

### Known Issues Log

1. ✅ **FIXED**: Detection results not displaying
   - Cause: `const texts = []` instead of reading state
   - Fix: Use `textBlocks` from Zustand store

2. ✅ **FIXED**: OCR not running
   - Cause: Empty array + no state updates
   - Fix: Crop regions, convert to ArrayBuffer, store results

3. ⚠️ **OPEN**: Segmentation mask ignored
   - Detection returns it but frontend discards it

4. ⚠️ **OPEN**: No translation implementation

5. ⚠️ **OPEN**: No inpainting UI

---

## Git Commit History Notes

### Recent Changes (Community Fixes)

**2025-10-04**: Fixed detection and OCR pipeline
- Added `textBlocks` to global state
- Implemented `imageBitmapToArrayBuffer()` helper
- Connected detection results to UI
- Connected OCR results to state
- Updated canvas to render bboxes from state

**Original State** (mayocream/koharu v0.1.11):
- Detection backend worked
- OCR backend worked
- Frontend had hardcoded empty arrays
- Translation panel was TODO stub
- Inpainting had no UI

---

## Next Steps (See TODO.md)

**Phase 1**: Complete segmentation viewing
**Phase 2**: Implement translation (API integration)
**Phase 3**: Build inpainting UI
**Phase 4**: Text rendering and export
**Phase 5**: Polish and optimization

---

## Developer Notes

### Code Organization

```
koharu/
├── src-tauri/           # Rust backend
│   ├── src/
│   │   ├── commands.rs  # Tauri commands (detection, ocr, inpaint)
│   │   ├── lib.rs       # App initialization, ONNX setup
│   │   └── state.rs     # Global app state with model instances
│   └── Cargo.toml       # Rust dependencies
├── comic-text-detector/ # Detection model wrapper
├── manga-ocr/           # OCR model wrapper
├── lama/                # Inpainting model wrapper
├── next/                # Frontend (React/Next.js)
│   ├── app/             # Next.js app router
│   ├── components/      # UI components
│   │   ├── detection-panel.tsx
│   │   ├── ocr-panel.tsx
│   │   ├── translation-panel.tsx
│   │   ├── canvas.tsx
│   │   └── tools.tsx
│   ├── lib/
│   │   ├── state.ts     # Zustand store
│   │   └── image.ts     # Image helpers
│   └── utils/
│       └── image.ts     # Crop, resize, bitmap conversion
└── target/release/      # Build output
```

### Important Files to Check

- `src-tauri/src/commands.rs` - All backend logic
- `next/lib/state.ts` - Global state shape
- `next/components/*-panel.tsx` - UI for each pipeline stage
- `README.md` - User-facing documentation
- `PIPELINE.md` - This file (technical deep-dive)
- `AGENTS.md` - AI agent coding guidance
- `TODO.md` - Roadmap and task breakdown

### Common Patterns

**Adding a new command**:
1. Add Rust function in `commands.rs` with `#[tauri::command]`
2. Add to handler in `lib.rs`: `tauri::generate_handler![..., new_command]`
3. Call from frontend: `invoke('new_command', { params })`

**Adding state**:
1. Update types in `lib/state.ts`
2. Add setter function
3. Use in components with `const { field, setField } = useEditorStore()`

**Image format conversions**:
- Frontend: `ImageBitmap` (for canvas rendering)
- Tauri IPC: `ArrayBuffer` → `Array<number>` (serialization)
- Backend: `Vec<u8>` → `image::DynamicImage`
