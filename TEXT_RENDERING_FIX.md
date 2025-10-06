# TEXT NOT RENDERING FIX

## The Real Problem

**Issue:** Exported images showed the inpainted/textless image correctly, but **translated text was NOT being drawn on top**.

## Root Cause

The text rendering helper function `drawTextWithSpacing` had a **critical bug** in how it handled the case when `letterSpacing === 0`:

### Broken Code:
```typescript
const drawTextWithSpacing = (text: string, x: number, y: number, drawFn: (char: string, cx: number, cy: number) => void) => {
  if (letterSpacing === 0) {
    drawFn(text, x, y)  // ❌ BUG: Calling callback with full text, but...
    return
  }
  // ... character-by-character rendering for letter spacing
}

// Called like this:
drawTextWithSpacing(line, centerX, y, (text, cx, cy) => {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.fillText(text, cx, cy)  // ❌ Missing maxWidth parameter!
  ctx.restore()
})
```

### Problems:
1. **Missing `maxWidth` parameter** - `ctx.fillText(text, cx, cy)` should be `ctx.fillText(text, cx, cy, maxWidth)` for proper text wrapping
2. **Overcomplicated callback** - Unnecessary `ctx.save()`/`ctx.restore()` and complex callback pattern
3. **Not matching working version** - Working version (commit 43289a2) simply called `ctx.fillText(line, centerX, y, maxWidth)` directly

## The Fix

Simplified the `drawTextWithSpacing` helper function:

### Fixed Code:
```typescript
const drawTextWithSpacing = (text: string, x: number, y: number, isStroke: boolean = false) => {
  if (letterSpacing === 0) {
    // ✅ Simple case: direct rendering with maxWidth
    if (isStroke) {
      ctx.strokeText(text, x, y, maxWidth)
    } else {
      ctx.fillText(text, x, y, maxWidth)
    }
    return
  }
  
  // Complex case: manual letter spacing (character-by-character)
  const totalWidth = measureTextWithSpacing(text)
  let currentX = x - totalWidth / 2
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const charWidth = ctx.measureText(char).width
    const charCenterX = currentX + charWidth / 2
    
    if (isStroke) {
      ctx.strokeText(char, charCenterX, y)
    } else {
      ctx.fillText(char, charCenterX, y)
    }
    
    currentX += charWidth + letterSpacing
  }
}

// Called like this:
drawTextWithSpacing(line, centerX, y, false) // false = fill text
drawTextWithSpacing(line, centerX, y, true)  // true = stroke (outline)
```

### Benefits:
1. ✅ **Includes `maxWidth`** - Text wraps correctly within bounding boxes
2. ✅ **Simpler API** - Boolean flag instead of callback function
3. ✅ **Matches working version** - Behavior identical to commit 43289a2
4. ✅ **No unnecessary state management** - No `ctx.save()`/`ctx.restore()` overhead

## Changes Made

### File: `next/components/render-panel.tsx`

1. **Fixed `exportImage()` function** (~line 365)
   - Simplified `drawTextWithSpacing` helper
   - Added `maxWidth` parameter to text rendering
   - Changed from callback pattern to boolean flag

2. **Fixed `generateFinalComposition()` function** (~line 571)
   - Same fix as above
   - Ensures preview and export use identical rendering logic

## Testing

The text should now render correctly:

1. Load image with manga/comic text
2. Run: Detection → OCR → Translation → **Process Colors**
3. Click **Export**
4. Check exported PNG - **translated text should be visible**

### Debug Logs to Check:

Look for these console messages:
```
[EXPORT] Drawing text for N blocks using Canvas 2D
[EXPORT] Text blocks: [...]  ← Should show text, fontSize, hasColor
[EXPORT] Drawing block: <text> font: <family> size: <px>
```

If you see:
```
[EXPORT] Skipping block: { hasText: false, hasFontSize: false, hasColor: false }
```

Then the issue is that `processColors()` wasn't run, or text blocks don't have required properties.

## Why This Happened

The overcomplicated helper function was introduced when adding letter spacing support, but it broke the simple case (`letterSpacing === 0`) by:
1. Not passing the `maxWidth` constraint
2. Adding unnecessary complexity with callbacks and save/restore
3. Deviating from the proven working implementation

The fix returns to the simple, direct Canvas API calls that were working in commit 43289a2, while still supporting letter spacing when needed.
