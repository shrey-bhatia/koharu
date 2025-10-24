# Export vs Preview Consistency Fix

## Current Status ✅

### What's Fixed
1. **`letterSpacing`** - Now working in both preview AND export
2. **`lineHeight`** - Now working in both preview AND export  
3. **DOM attachment** - Konva stage properly attached to DOM for rendering
4. **Font loading** - Proper async handling with `requestAnimationFrame`
5. **Canvas conversion** - Properly awaited `toCanvas()`

### What's Still Broken ❌
1. **`fontWeight`** - UI allows customization but doesn't render
2. **`fontStretch`** - UI allows customization but doesn't render

## The Problem Flow

```
User Action → State Update → Preview Render → Export Render
     ✅           ✅              ⚠️               ⚠️
```

### Before This Fix:
- User sets `letterSpacing = 5px` in UI
- State updates: `block.letterSpacing = 5`
- **Preview**: Ignores it ❌ (shows default spacing)
- **Export**: Also ignored it ❌ (inconsistent with preview)
- **Result**: User sees one thing, exports another

### After This Fix:
- User sets `letterSpacing = 5px` in UI
- State updates: `block.letterSpacing = 5`
- **Preview**: Uses it ✅ (shows 5px spacing)
- **Export**: Uses it ✅ (matches preview exactly)
- **Result**: WYSIWYG - What You See Is What You Get!

## Remaining Issues

### Issue #1: Font Weight Not Working

**Current State:**
- UI has a dropdown for font weight (100, 300, 400, 500, 600, 700, 800, 900)
- State stores: `block.fontWeight = 700` or `'bold'`
- Preview ignores it
- Export ignores it

**Why:**
Konva doesn't have a `fontWeight` property. It uses `fontStyle` which accepts:
- `'normal'`
- `'bold'`
- `'italic'`
- `'italic bold'`
- Numeric values like `'500'`, `'700'`

**Fix Needed:**
Convert `fontWeight` to Konva's `fontStyle` format in both preview and export.

```typescript
// In both canvas.tsx and konva-text-render.ts
const getFontStyle = (block: TextBlock): string => {
  const parts: string[] = []
  
  // Handle font weight
  if (block.fontWeight) {
    if (block.fontWeight === 'bold' || block.fontWeight >= 600) {
      parts.push('bold')
    } else if (typeof block.fontWeight === 'number') {
      // Konva accepts numeric font weights as strings
      parts.push(block.fontWeight.toString())
    }
  }
  
  return parts.join(' ') || 'normal'
}

// Then use it:
<Text
  fontStyle={getFontStyle(block)}
  // ... other props
/>
```

### Issue #2: Font Stretch Not Supported

**Current State:**
- UI has a dropdown for font stretch (normal, condensed, expanded)
- State stores: `block.fontStretch = 'condensed'`
- Preview ignores it
- Export ignores it

**Why:**
Konva's `fontVariant` only supports:
- `'normal'` (default)
- `'small-caps'`

It does NOT support:
- `'condensed'`
- `'expanded'`
- `'ultra-condensed'`
- etc.

**Fix Options:**

**Option A: Remove the UI**
- Remove font stretch dropdown from `render-customization.tsx`
- Remove `fontStretch` from state
- Simplest solution

**Option B: CSS Transform Workaround**
- Use Konva's `scaleX` property to simulate stretching
- `condensed` → `scaleX: 0.8`
- `expanded` → `scaleX: 1.2`
- Not true font stretching, may look bad

**Option C: Use Real Font Variants**
- If user has "Arial Condensed" installed, switch to that font
- Complex font detection required
- May not work across all systems

**Recommendation: Option A** - Remove the UI option since it doesn't work

## Implementation Checklist

- [x] Add `letterSpacing` to preview (canvas.tsx)
- [x] Add `letterSpacing` to export (konva-text-render.ts)
- [x] Add `lineHeight` to preview
- [x] Add `lineHeight` to export
- [x] Fix DOM attachment for Konva
- [x] Fix async font loading
- [ ] Add `fontWeight` support (convert to `fontStyle`)
- [ ] Remove or fix `fontStretch` option
- [ ] Update documentation

## Testing Checklist

### Manual Testing
1. ✅ Load an image with text
2. ✅ Run Detection → OCR → Translation
3. ✅ Click "Process" in Render panel
4. ✅ Adjust `letterSpacing` in customization panel
5. ✅ Verify preview updates immediately
6. ✅ Click "Export"
7. ✅ Verify exported image matches preview exactly

### Test Cases
- [ ] `letterSpacing = 0` (default)
- [ ] `letterSpacing = 5` (positive spacing)
- [ ] `letterSpacing = -2` (negative spacing)
- [ ] `lineHeight = 1.0` (tight)
- [ ] `lineHeight = 1.5` (relaxed)
- [ ] `lineHeight = 2.0` (double-spaced)
- [ ] `fontWeight = 700` (bold)
- [ ] `fontWeight = 300` (light)
- [ ] Mixed: letter spacing + line height together

## Files Modified

### ✅ Already Updated
- `next/components/canvas.tsx` - Added `letterSpacing` and `lineHeight` to preview
- `next/utils/konva-text-render.ts` - Added same properties to export
- `KONVA_EXPORT_FIX.md` - Documentation

### ⏳ Needs Update
- `next/components/canvas.tsx` - Add `fontStyle` conversion
- `next/utils/konva-text-render.ts` - Add `fontStyle` conversion
- `next/components/render-customization.tsx` - Remove or fix `fontStretch` dropdown

## Summary

**The core export bug is now FIXED** ✅

The export function now uses the same Konva properties as the preview, ensuring WYSIWYG consistency. Users can customize `letterSpacing` and `lineHeight`, and see those changes reflected in both preview and export.

However, `fontWeight` and `fontStretch` customizations still don't work. These require additional implementation or removal from the UI.

**Priority**: Medium
- Most users won't notice missing font weight/stretch
- Core functionality (letter spacing, line height) is working
- Can be addressed in a follow-up PR
