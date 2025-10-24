# CRITICAL DIAGNOSIS: Duplicate Inpainting Paths

## 🔴 The Root Problem

You discovered that **debug mode produces perfect results** but **normal mode produces broken white inpainting**. Here's why:

### Two Separate Inpainting Code Paths

**Path 1: OLD BROKEN `inpaint` command** (commands.rs:47)
```rust
pub async fn inpaint(app: AppHandle, image: Vec<u8>, mask: Vec<u8>) -> CommandResult<Vec<u8>> {
    let state = app.state::<AppState>();
    let img = image::load_from_memory(&image)?;
    let mask_img = image::load_from_memory(&mask)?;
    
    // DIRECT CALL - no cropping, no erosion, no per-region logic!
    let result = state.lama.lock().await.inference(&img, &mask_img)?;
    // Returns full white-filled image
}
```

**Path 2: NEW GOOD `inpaint_region` command** (commands.rs:103)
```rust
pub async fn inpaint_region(
    app: AppHandle,
    image: Vec<u8>,
    mask: Vec<u8>,
    bbox: BBox,
    padding: Option<i32>,
    debug_mode: Option<bool>,  // ← This is where debug mode works!
) -> CommandResult<InpaintedRegion> {
    // Has all the fixes: cropping, erosion, proper masking, debug exports
    // THIS WORKS PERFECTLY
}
```

### Where Each Is Used

**Frontend routing** (inpaint-panel.tsx:36-43):
```typescript
if (renderMethod === 'newlama') {
  await runNewLamaInpainting()      // ✅ Uses inpaint_region (GOOD)
} else if (renderMethod === 'lama') {
  await runLocalizedInpainting()    // ✅ Uses inpaint_region (GOOD)
} else {
  await runFullInpainting()         // ❌ Uses old inpaint (BROKEN)
}
```

**But wait!** Even when you select LaMa/NewLaMa:
- Inpainting works (uses `inpaint_region`) ✅
- **BUT** the export still draws rectangles on top! ❌

### The Rectangle Problem

**Export function** (render-panel.tsx:147-159):
```typescript
// 2. Draw rounded rectangles
for (const block of textBlocks) {
  if (!block.backgroundColor) continue
  
  const bg = block.manualBgColor || block.backgroundColor
  ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
  ctx.fill()  // ← ALWAYS DRAWS RECTANGLES, even in LaMa mode!
}
```

This happens **regardless** of render method!

## 🎯 The Fix Plan

### Fix 1: Remove Old `inpaint` Command (IMMEDIATE)

The old full-image `inpaint` command serves no purpose now:
- It's the broken white-fill behavior
- `inpaint_region` does everything better
- No code should call it

**Action**: Delete or deprecate the old `inpaint` command.

### Fix 2: Conditional Rectangle Drawing (IMMEDIATE)

Rectangles should **only** be drawn in Rectangle Fill mode, not LaMa mode:

```typescript
// In exportImage()
const shouldDrawRectangles = renderMethod === 'rectangle'

if (shouldDrawRectangles) {
  // 2. Draw rounded rectangles
  for (const block of textBlocks) {
    // ... existing rectangle drawing code
  }
}

// 3. Always draw text on top
```

### Fix 3: Verify Color Extraction (VERIFY)

Ensure "Process" step extracts colors from original even in LaMa mode (already fixed but verify).

### Fix 4: Clean Up Render Methods (CLARITY)

Make it explicit:

**Rectangle Fill**:
- Base: Original image
- Add: Colored rectangles + text
- No inpainting

**LaMa / NewLaMa**:
- Base: Inpainted image (textless plate)
- Add: Text only (NO rectangles!)
- Inpainting uses per-region with erosion

## 🔍 Why Debug Mode Works

When you enable debug mode:
1. Uses `inpaint_region` with `debug_mode: true` ✅
2. Applies all the fixes: erosion, nearest-neighbor, proper cropping ✅
3. Exports triptychs showing perfect masking ✅
4. **This is the CORRECT behavior** ✅

When debug mode is OFF:
1. **SAME CODE PATH** (`inpaint_region` with `debug_mode: false`)
2. Just skips the export, but **masking is identical** ✅

So debug mode itself isn't the fix - the issue is that:
- The OLD `inpaint` command still exists and may be called somewhere
- Rectangles are ALWAYS drawn regardless of render method

## 📋 Implementation Steps

### Step 1: Remove Old Inpaint Command

**File**: `src-tauri/src/commands.rs`

**Action**: Comment out or delete lines 47-68 (the old `inpaint` function)

**Verification**: Build should fail if anything still calls it → find and fix those calls

### Step 2: Make Rectangle Drawing Conditional

**File**: `next/components/render-panel.tsx`

**Before** (lines 147-159):
```typescript
// 2. Draw rounded rectangles
for (const block of textBlocks) {
  if (!block.backgroundColor) continue
  // ... always draws
}
```

**After**:
```typescript
// 2. Draw rounded rectangles (Rectangle Fill mode only)
if (renderMethod === 'rectangle') {
  for (const block of textBlocks) {
    if (!block.backgroundColor) continue
    // ... draw rectangles
  }
}
```

### Step 3: Update Inpaint Panel Logic

**File**: `next/components/inpaint-panel.tsx`

**Change** (line 41):
```typescript
// OLD:
} else {
  await runFullInpainting()  // ← Delete this, it's broken
}

// NEW:
} else {
  // Rectangle fill doesn't need inpainting
  setError('Rectangle fill mode selected. No inpainting needed.')
  return
}
```

Actually, the button should already be disabled for rectangle mode (we added that), so this branch might never execute!

### Step 4: Verify No Other Calls to Old `inpaint`

**Search**: `invoke('inpaint'` in all frontend files
**Action**: Replace with `inpaint_region` calls where needed

## 🧪 Testing Plan

### Test 1: LaMa Mode (No Rectangles)
1. Select "NewLaMa (Best Quality)"
2. Run Inpaint → verify per-region processing
3. Run Process → verify colors from original
4. Export → **verify NO rectangles drawn, just text on textless plate**

### Test 2: Rectangle Fill Mode
1. Select "Rectangle Fill"
2. Inpaint button should be disabled
3. Run Process → extract colors
4. Export → **verify rectangles ARE drawn (this mode needs them)**

### Test 3: Debug Mode Verification
1. Enable debug mode
2. Run LaMa inpainting
3. Check triptychs → should match non-debug results
4. Verify both produce same quality output

## ✅ Expected Results After Fixes

**LaMa/NewLaMa Mode**:
```
Original image → Per-region inpaint → Textless plate
                                           ↓
                                      Add text only (no rectangles)
                                           ↓
                                      Final: Textless + translated text
```

**Rectangle Fill Mode**:
```
Original image → Extract colors → Draw rectangles → Add text
                                       ↓
                              Final: Original + rectangles + text
```

## 🚫 What Gets Removed

1. **Old `inpaint` command** (commands.rs:47-68) → DELETED
2. **`runFullInpainting()`** (inpaint-panel.tsx:45-71) → DELETED or error handler
3. **Unconditional rectangle drawing** → MADE CONDITIONAL

## 📝 Summary

**The Real Issue**: Not debug mode vs normal mode, but:
1. Old broken `inpaint` command still exists (may be called somewhere)
2. Rectangles always drawn regardless of render method
3. Two code paths doing same thing differently

**The Solution**:
1. Delete old `inpaint` command
2. Make rectangles conditional on `renderMethod === 'rectangle'`
3. Keep only the good per-region inpainting path

**Why Debug Mode "Works"**: It doesn't - it's just that `inpaint_region` (used by LaMa/NewLaMa) is already correct, but then rectangles are slapped on top during export, hiding the good inpainting!

Ready to implement?
