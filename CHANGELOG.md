
## [Unreleased] - 2025-01-XX

### Added - Pipeline Stage Viewer & GPU Configuration

#### 1. **Pipeline Stage Viewer** ✅
Visualize the complete manga translation pipeline at each stage:

**Frontend Changes:**
- **`topbar.tsx`**: Added stage navigation buttons (Original → Textless → +Backgrounds → Final)
  - Shows in render/inpaint modes only
  - Buttons disabled until stage is generated
  - Active stage highlighted in blue
  
- **`canvas.tsx`**: Updated rendering to respect `currentStage`
  - Dynamically displays base image based on selected stage
  - Conditional overlay rendering (rectangles on stage 3, text on stage 4)
  - Seamless switching between pipeline stages
  
- **`inpaint-panel.tsx`**: All inpainting methods now save to pipeline stages
  - Auto-switches to "Textless" view after inpainting completes
  - Stores result in `pipelineStages.textless`
  
- **`render-panel.tsx`**: Export function generates intermediate stages
  - Saves `withRectangles` stage (base + backgrounds, no text)
  - Saves `final` stage (complete translated image)
  - Auto-switches to "Final" view after export

**State Changes:**
- **`state.ts`**: Added pipeline tracking
  ```typescript
  currentStage: 'original' | 'textless' | 'rectangles' | 'final'
  pipelineStages: {
    original: Image | null
    textless: Image | null
    withRectangles: Image | null
    final: Image | null
  }
  ```

**Benefits:**
- Users can now see the textless inpainted background before text overlay
- Compare original vs final side-by-side
- Debug inpainting quality issues
- Understand what each processing step accomplishes

---

#### 2. **GPU Selection & Configuration** ✅
Users can now select which GPU/CPU to use for AI inference, with persistent configuration.

**Backend Changes (Rust):**

- **`lib.rs`**: 
  - Added `read_gpu_preference()` to load config from persistent file
  - Modified `initialize()` to configure ORT based on GPU preference:
    - **CUDA**: NVIDIA GPUs with `.error_on_failure()` (no silent fallback)
    - **DirectML**: Intel/AMD GPUs on Windows
    - **CPU**: Fallback for all platforms
  - Reads config from: `%APPDATA%/com.koharu.app/gpu_preference.txt` (Windows)

- **`commands.rs`**:
  - Added `set_gpu_preference(preference: String)` command
  - Saves preference to persistent config file
  - Returns success/error to frontend

**Frontend Changes (TypeScript/React):**

- **`state.ts`**: 
  - Added `gpuPreference: 'cuda' | 'directml' | 'cpu'` to state
  - Persists to localStorage + backend config file
  - Default: CUDA (best for NVIDIA users)

- **`settings-dialog.tsx`**:
  - Added GPU preference dropdown with 3 options:
    - NVIDIA CUDA (Best Performance)
    - DirectML (Intel/AMD GPU)
    - CPU Only (Slowest)
  - Calls `invoke('set_gpu_preference')` on change
  - Shows restart warning callout when changed
  - Includes hardware requirement descriptions

**Important Constraints:**
- **Restart Required**: ORT can only be initialized once; app must restart for changes to take effect
- **Compile-Time Features**: CUDA requires `--features cuda` build flag
- **Platform Restrictions**: DirectML is Windows-only

**Config File Location:**
- Windows: `%APPDATA%/com.koharu.app/gpu_preference.txt`
- macOS: `~/Library/Application Support/com.koharu.app/gpu_preference.txt`
- Linux: `~/.config/com.koharu.app/gpu_preference.txt`

**Performance Comparison:**
| Provider  | Speed         | Hardware                  |
|-----------|---------------|---------------------------|
| CUDA      | ~100ms/image  | NVIDIA GPU (CUDA 11.x+)   |
| DirectML  | ~300ms/image  | Intel/AMD GPU             |
| CPU       | ~2-5s/image   | Any CPU (very slow)       |

**Troubleshooting:**
- Check console logs for "Initialized ORT with CUDA" message
- Verify config file contains correct preference
- Ensure NVIDIA drivers and CUDA 11.x are installed
- Use `nvidia-smi` to confirm GPU availability

---

### Documentation Updates

- **`INPAINTING_SPEC.md`**: Added comprehensive GPU Configuration section (lines 1869-2041)
  - Implementation details for backend and frontend
  - Performance benchmarks
  - Troubleshooting guide
  - Config file locations

---

### Files Modified

**Backend (Rust):**
- `src-tauri/src/lib.rs` - GPU preference loading and ORT configuration
- `src-tauri/src/commands.rs` - Added `set_gpu_preference` command

**Frontend (TypeScript/React):**
- `next/lib/state.ts` - Added pipeline stages and GPU preference state
- `next/components/topbar.tsx` - Stage navigation buttons
- `next/components/canvas.tsx` - Stage-aware rendering
- `next/components/inpaint-panel.tsx` - Pipeline stage storage
- `next/components/render-panel.tsx` - Intermediate stage generation, correct base image usage
- `next/components/settings-dialog.tsx` - GPU preference dropdown

**Documentation:**
- `INPAINTING_SPEC.md` - GPU configuration documentation
- `CHANGELOG.md` - This entry

---

### Status

**Completed (Steps 4-6):**
- ✅ Step 4: Add stage viewer buttons in topbar
- ✅ Step 5: Wire canvas to display selected stage
- ✅ Step 6: Update backend to read GPU preference and configure ORT

**Remaining:**
- ⏳ Step 7: Improve mask quality with dilation and padding (pending user approval)

