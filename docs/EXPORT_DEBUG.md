# Export Debugging Checklist

## Test Steps

1. **Start Dev Server**
   ```bash
   cd koharu/next && bun run dev
   ```
   - Opens at http://localhost:9000

2. **Load Test Image**
   - Open the app
   - Load an image with Japanese text

3. **Run Full Pipeline**
   - Click "Detect" → Should see red boxes around text
   - Click "OCR" → Should see Japanese text extracted
   - Click "Translate" → Should see English translations
   - Click "Process" in Render panel → Should calculate colors/fonts

4. **Check Console Logs**
   Open browser DevTools (F12) and look for:
   - `[EXPORT] Drawing base image`
   - `[EXPORT] Drawing text for X blocks using Konva`
   - `[KONVA] Rendering text: "..."`
   - `[KONVA] Layer drawn, converting to canvas...`
   - `[KONVA] Canvas obtained, drawing to target...`
   - `[KONVA] Text rendered to HTMLCanvasElement`
   - `[KONVA] Cleanup complete`

5. **Click Export**
   - Should trigger file download
   - Check for errors in console

## Common Errors to Check

### Error: "Failed to get canvas context"
- **Cause**: Canvas creation failed
- **Fix**: Check if `createCanvas` utility is working

### Error: "Failed to convert canvas to blob"
- **Cause**: `canvasToBlob` utility failing
- **Fix**: Check canvas is valid and not tainted

### Error: Konva crashes with "Cannot read properties of undefined"
- **Cause**: Block data missing required fields
- **Fix**: Ensure all blocks have `translatedText`, `fontSize`, and `textColor`

### Error: Export downloads but image is blank/corrupt
- **Cause**: Konva rendering not completing before export
- **Fix**: Check if `renderTextWithKonva` is properly awaited

### Error: Text missing from export
- **Cause**: Multiple possible issues:
  1. Konva stage not properly rendering
  2. Font not loading
  3. letterSpacing/lineHeight causing crash
- **Fix**: Check console logs with debug=true

## What to Report

If export still fails, provide:

1. **Console Logs**: Copy all [EXPORT] and [KONVA] messages
2. **Error Messages**: Any red errors in console
3. **Browser**: Chrome/Firefox/Edge version
4. **Image Details**: Size, number of text blocks detected
5. **Stage**: Where does it fail? (After clicking export? After processing?)

## Expected Console Output (Success Case)

```
[EXPORT] Drawing base image
[EXPORT] Drawing text for 5 blocks using Konva
[KONVA] Rendering text: "Hello"
[KONVA] Rendering text: "World"
[KONVA] Rendering text: "Test"
[KONVA] Rendering text: "More text"
[KONVA] Rendering text: "Final"
[KONVA] Layer drawn, converting to canvas...
[KONVA] Canvas obtained, drawing to target...
[KONVA] Text rendered to HTMLCanvasElement
[KONVA] Cleanup complete
Image exported successfully!
```

## Quick Fixes

### If export button does nothing:
Check if `hasProcessedColors` is true (Process must be run first)

### If export downloads empty file:
Check if `textBlocks` array is populated with translated text

### If preview shows text but export doesn't:
Compare canvas.tsx and konva-text-render.ts properties - they must match!

### If Konva crashes:
Check browser console for the exact error line - it will tell you which property is causing issues
