# AI Agent & Developer Guidance for Koharu

This document provides guidance for AI coding agents (Claude, GPT, Codex, etc.) and human developers working on the Koharu manga translation project.

---

## Quick Start for AI Agents

### Context Requirements

Before making changes, you MUST:

1. **Read PIPELINE.md** - Understand current implementation status
2. **Read TODO.md** - Check what phase/task you're working on
3. **Check git log** - Review recent commits to understand what's been done
4. **Read relevant source files** - Don't assume, verify current code

### Prohibited Actions

❌ **DO NOT**:
- Make changes without understanding the full pipeline
- Assume functionality exists without verifying
- Skip reading state management code before modifying components
- Commit API keys, secrets, or credentials
- Break existing working functionality (detection, OCR are working!)
- Use `console.log` instead of proper error handling in production code
- Create files without understanding the project structure

---

## Development Philosophy

### Test-Driven Approach (CRITICAL)

This project follows a **test-verify-commit** cycle:

```
1. READ   → Understand what exists and what's broken
2. PLAN   → Document what you'll change and why
3. CODE   → Make minimal changes to fix one thing
4. TEST   → Actually run the app and verify it works
5. COMMIT → Document what you did
6. UPDATE → Update relevant .md files
```

**Why This Matters**:
- Build takes 3-7 minutes → shooting in the dark wastes hours
- Frontend/backend interactions are complex → need to trace full data flow
- State management bugs are subtle → need to verify UI updates

### Testing Checklist

Before committing ANY change:

- [ ] Build succeeds: `bun tauri build -- --features=cuda`
- [ ] App launches without errors
- [ ] Existing features still work (don't break detection/OCR!)
- [ ] New feature works as intended
- [ ] Browser console shows no errors
- [ ] Checked DevTools Network tab for failed requests
- [ ] Updated documentation if behavior changed

---

## Project Structure & Conventions

### Backend (Rust + Tauri)

**Key Files**:
- `src-tauri/src/commands.rs` - All Tauri commands (frontend ↔ backend bridge)
- `src-tauri/src/lib.rs` - App initialization, ONNX Runtime setup
- `src-tauri/src/state.rs` - Global state holding model instances
- `*/src/lib.rs` - Model wrapper crates (comic-text-detector, manga-ocr, lama)

**Patterns**:

```rust
// Adding a new Tauri command
#[tauri::command]
pub async fn my_command(
    app: AppHandle,
    param: SomeType,
) -> CommandResult<ReturnType> {
    let state = app.state::<AppState>();

    // Your logic here
    let result = state.model.lock().await.inference(...)?;

    Ok(result)
}

// Then register in lib.rs
.invoke_handler(tauri::generate_handler![
    detection,
    ocr,
    inpaint,
    my_command  // Add here
])
```

**Important**:
- All commands are async (models can take seconds to run)
- Use `.lock().await` to access models (they're behind Mutex)
- Return `CommandResult<T>` for proper error handling
- Image data comes as `Vec<u8>` from frontend

### Frontend (React + Next.js + TypeScript)

**Key Files**:
- `next/lib/state.ts` - Zustand global state (THE source of truth)
- `next/components/*-panel.tsx` - UI panels for each pipeline stage
- `next/components/canvas.tsx` - Konva canvas for rendering
- `next/utils/image.ts` - Image manipulation helpers

**State Management Pattern**:

```typescript
// 1. Define types in state.ts
export type MyType = {
  field: string
}

// 2. Add to store
const store = {
  myData: null as MyType | null,
  // ...
}

// 3. Add setter
(set) => ({
  setMyData: (data: MyType | null) => set({ myData: data }),
})

// 4. Use in component
const { myData, setMyData } = useEditorStore()
```

**Tauri Invoke Pattern**:

```typescript
import { invoke } from '@tauri-apps/api/core'

// Call backend command
const result = await invoke<ReturnType>('command_name', {
  paramName: value,  // Snake_case matches Rust
})
```

**Image Handling**:

```typescript
// Frontend uses ImageBitmap for canvas rendering
const bitmap: ImageBitmap = image.bitmap

// But Tauri needs ArrayBuffer → Array
const buffer = await imageBitmapToArrayBuffer(bitmap)
const array = Array.from(new Uint8Array(buffer))

await invoke('command', { image: array })
```

---

## Common Tasks & How-Tos

### Adding a New Pipeline Stage

**Example: Implementing Translation**

1. **Check backend** - Does the command exist?
   ```bash
   grep -r "translate" src-tauri/src/
   ```

2. **If backend missing**, add it:
   ```rust
   // commands.rs
   #[tauri::command]
   pub async fn translate(text: String, api_key: String) -> CommandResult<String> {
       // Call LLM API
       Ok(translated_text)
   }
   ```

3. **Update state** - Add field for results:
   ```typescript
   // state.ts
   type TextBlock = {
       // ...
       translatedText?: string  // Add this
   }
   ```

4. **Create/update panel**:
   ```typescript
   // translation-panel.tsx
   const { textBlocks, setTextBlocks } = useEditorStore()

   const translate = async () => {
       const updated = await Promise.all(
           textBlocks.map(async (block) => {
               const translated = await invoke('translate', {
                   text: block.text
               })
               return { ...block, translatedText: translated }
           })
       )
       setTextBlocks(updated)
   }
   ```

5. **Test incrementally**:
   - Add console.log to verify data flow
   - Test with one text block first
   - Check error handling
   - Verify UI updates

6. **Document**:
   - Update PIPELINE.md with implementation status
   - Update TODO.md to mark task complete
   - Add commit message explaining what you did

### Debugging Data Flow Issues

**Symptoms**: Button does nothing, UI doesn't update, results disappear

**Checklist**:

1. **Check state is being read**:
   ```typescript
   const { field } = useEditorStore()
   console.log('Current state:', field)  // Should NOT be undefined
   ```

2. **Check state is being written**:
   ```typescript
   const { setField } = useEditorStore()
   setField(newValue)
   console.log('After set:', useEditorStore.getState().field)
   ```

3. **Check backend is being called**:
   ```typescript
   try {
       const result = await invoke('command', params)
       console.log('Backend returned:', result)
   } catch (err) {
       console.error('Backend error:', err)  // Check this!
   }
   ```

4. **Check backend is receiving data**:
   ```rust
   // In Rust command
   println!("Received params: {:?}", param);
   ```

5. **Check image format conversions**:
   - Is ImageBitmap being converted to ArrayBuffer?
   - Is ArrayBuffer being converted to Array<number>?
   - Is backend converting Vec<u8> to DynamicImage correctly?

### Working with Images

**Frontend → Backend**:

```typescript
// 1. Crop region (returns ImageBitmap)
const cropped = await crop(image.bitmap, x, y, width, height)

// 2. Convert to buffer
const buffer = await imageBitmapToArrayBuffer(cropped)

// 3. Convert to array for Tauri
const array = Array.from(new Uint8Array(buffer))

// 4. Send to backend
await invoke('ocr', { image: array })
```

**Backend → Frontend**:

```rust
// Backend returns image as Vec<u8>
Ok(result.into_bytes().to_vec())
```

```typescript
// Frontend receives as number[]
const result = await invoke<number[]>('inpaint', { ... })

// Convert back to ImageBitmap
const buffer = new Uint8Array(result).buffer
const blob = new Blob([buffer])
const bitmap = await createImageBitmap(blob)
```

---

## Build System & Performance

### Build Commands

```bash
# Development (fast, hot reload, no optimization)
bun tauri dev

# Production build (slow, optimized, includes CUDA)
bun tauri build -- --features=cuda

# Build without bundlers (faster, for testing)
bun tauri build -- --features=cuda --no-bundle

# Frontend only (quick iteration on UI)
cd next && bun run build
```

### Why Builds Are Slow

1. **Rust compilation** (~2-3 min):
   - Large dependency tree (ONNX Runtime, Candle, image libs)
   - CUDA bindings compile C++ code
   - LTO (Link-Time Optimization) enabled in release mode

2. **Frontend build** (~30-60 sec):
   - Next.js optimization passes
   - Tailwind CSS processing
   - Bundle generation

3. **Packaging** (~30 sec):
   - MSI installer creation
   - NSIS installer creation
   - Code signing (if configured)

### Speed Up Builds

**Option 1: Use dev mode for testing**
```bash
bun tauri dev  # Hot reload, skips optimization
```

**Option 2: Install sccache (Rust compilation cache)**
```bash
cargo install sccache
# Add to ~/.cargo/config.toml or set RUSTC_WRAPPER=sccache
```

**Option 3: Disable LTO temporarily**
```toml
# Cargo.toml (but don't commit this!)
[profile.release]
lto = false  # Faster build, larger binary
```

**Option 4: Build incrementally**
```bash
# Only rebuild frontend
cd next && bun run build

# Only rebuild Rust (rare - backend changes less)
cd src-tauri && cargo build --release --features=cuda
```

**DO NOT**:
- Remove dependencies to speed up builds (will break functionality)
- Skip testing because builds are slow (leads to more wasted time)
- Use debug builds for end-users (10x slower at runtime)

---

## Git Workflow & Commit Hygiene

### Commit Message Format

```
<type>: <short summary>

<detailed explanation if needed>

- What was broken/missing
- What you changed
- How to test the fix

Files changed:
- path/to/file.ts
- path/to/other.rs
```

**Types**:
- `fix:` - Bug fix (e.g., "fix: detection results not displaying")
- `feat:` - New feature (e.g., "feat: implement translation API")
- `docs:` - Documentation only
- `refactor:` - Code restructure without behavior change
- `test:` - Adding tests
- `chore:` - Build system, dependencies

### Before Committing

1. **Test thoroughly** (see Testing Checklist above)
2. **Update documentation**:
   - PIPELINE.md if implementation status changed
   - TODO.md if task completed
   - README.md if user-facing behavior changed
3. **Check for secrets**:
   ```bash
   git diff --cached | grep -i "api_key\|secret\|password"
   ```
4. **Verify working state**:
   ```bash
   git status  # Check what's staged
   git diff --cached  # Review actual changes
   ```

### .gitignore Reminders

Never commit:
- `.env` files
- `config.json` with API keys
- `/target` (Rust build artifacts)
- `/node_modules`
- `*.log`
- Personal test images with copyrighted manga

---

## Common Pitfalls & Solutions

### Pitfall 1: "Empty array hardcoded"

**Symptom**: Feature runs but nothing displays

**Example**:
```typescript
// ❌ WRONG
const texts = []  // This will ALWAYS be empty!

// ✅ RIGHT
const { textBlocks } = useEditorStore()
```

**How to find**: Search for `const.*= \[\]` in component files

---

### Pitfall 2: "Results not stored in state"

**Symptom**: Backend returns data but UI doesn't update

**Example**:
```typescript
// ❌ WRONG
const result = await invoke('command', params)
console.log(result)  // Logs it but doesn't store it!

// ✅ RIGHT
const result = await invoke('command', params)
setTextBlocks(result.bboxes)  // Store in state
```

---

### Pitfall 3: "Wrong image format"

**Symptom**: Backend errors like "Failed to load image"

**Example**:
```typescript
// ❌ WRONG
const cropped = await crop(image.bitmap, ...)
await invoke('ocr', { image: cropped })  // ImageBitmap isn't serializable!

// ✅ RIGHT
const cropped = await crop(image.bitmap, ...)
const buffer = await imageBitmapToArrayBuffer(cropped)
const array = Array.from(new Uint8Array(buffer))
await invoke('ocr', { image: array })
```

---

### Pitfall 4: "Async/await missing"

**Symptom**: Function returns `Promise` instead of value

**Example**:
```typescript
// ❌ WRONG
const run = () => {
    const result = invoke('command', params)  // Missing await!
    setData(result)  // result is Promise, not data
}

// ✅ RIGHT
const run = async () => {
    const result = await invoke('command', params)
    setData(result)
}
```

---

### Pitfall 5: "Math.floor missing on coordinates"

**Symptom**: Canvas errors or invalid crop regions

**Example**:
```typescript
// ❌ WRONG
const cropped = await crop(image.bitmap, xmin, ymin, width, height)
// If xmin = 123.456, crop may fail

// ✅ RIGHT
const cropped = await crop(
    image.bitmap,
    Math.floor(xmin),
    Math.floor(ymin),
    Math.floor(width),
    Math.floor(height)
)
```

---

## API Integration Guidelines

### Environment Variables (for API keys)

**Development**:
```bash
# .env.local (gitignored)
NEXT_PUBLIC_GEMINI_API_KEY=your_key_here
```

**Access in code**:
```typescript
const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY
```

**Production** (Tauri app):
- Use Tauri's secure storage plugin
- Or prompt user to enter key in settings UI
- Never hardcode or commit keys

### Rate Limiting

If using free API tiers:
- Add delays between requests: `await sleep(1000)`
- Batch requests when possible
- Show progress to user (e.g., "Translating block 3/12...")
- Handle 429 errors gracefully

### Error Handling

```typescript
try {
    const result = await callAPI(...)
} catch (err) {
    if (err.status === 429) {
        // Rate limit - wait and retry
        await sleep(5000)
        return callAPI(...)
    } else if (err.status === 401) {
        // Invalid API key
        alert('Invalid API key. Check settings.')
    } else {
        // Other error
        console.error('API error:', err)
        throw err
    }
}
```

---

## Debugging Tools

### Browser DevTools

1. **Console**: Check for errors and logs
2. **Network**: See Tauri IPC calls (look for `ipc` protocol)
3. **React DevTools**: Inspect component state
4. **Application**: Check localStorage, sessionStorage

### Rust Debugging

```rust
// In commands.rs
println!("Debug: {:?}", variable);  // Prints to terminal running `bun tauri dev`

// Or use proper logging
log::info!("Processing {} blocks", count);
log::error!("Failed to load image: {}", err);
```

### Common Debug Patterns

```typescript
// Trace data flow
console.log('1. Input:', input)
const result = await invoke('command', { input })
console.log('2. Backend returned:', result)
setData(result)
console.log('3. State after set:', useEditorStore.getState().data)
```

---

## When You Get Stuck

1. **Read PIPELINE.md** - Understand what's supposed to happen
2. **Check git log** - See if someone already tried this
3. **Search codebase**: `grep -r "keyword" .`
4. **Verify assumptions**:
   - Is the backend command registered?
   - Is state being read from the right place?
   - Is data being transformed correctly?
5. **Simplify**:
   - Comment out complex logic
   - Test with hardcoded data first
   - Add one feature at a time
6. **Document findings** - Update PIPELINE.md with discoveries

---

## Final Reminders for AI Agents

### Before Starting Work

✅ Checklist:
- [ ] Read PIPELINE.md to understand current state
- [ ] Read TODO.md to know what task to work on
- [ ] Check `git log --oneline -10` for recent changes
- [ ] Understand the full data flow for the feature you're adding
- [ ] Plan minimal changes (don't rewrite working code)

### Before Committing

✅ Checklist:
- [ ] Code builds: `bun tauri build -- --features=cuda`
- [ ] App runs and feature works
- [ ] No regressions (detection and OCR still work)
- [ ] Updated PIPELINE.md if implementation status changed
- [ ] Updated TODO.md if task completed
- [ ] Wrote clear commit message
- [ ] No secrets/API keys in code

### When Handing Off

Update TODO.md with:
- What you completed
- What's left to do
- Any blockers or issues discovered
- Suggestions for next steps

This ensures the next agent/developer can pick up where you left off.

---

## Resources

- **Tauri Docs**: https://tauri.app/v2/
- **ONNX Runtime Rust**: https://docs.rs/ort/
- **Zustand**: https://github.com/pmndrs/zustand
- **Konva.js**: https://konvajs.org/docs/
- **Next.js**: https://nextjs.org/docs

---

**Remember**: This is a community-fixed project. Your changes will help future contributors. Write code and documentation like you're helping your future self debug at 2am. Good luck! 🚀
