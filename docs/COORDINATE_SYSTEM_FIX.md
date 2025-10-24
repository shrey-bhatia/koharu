# Coordinate System Fix - Text Area Dragging

## Problem

When dragging text detection areas:
1. **Image would disappear** when releasing the drag
2. **OCR produced invalid bounding boxes** like `[16822.00,9775.00->4299.00,6071.00]` (xmax < xmin)

## Root Cause

**Critical misunderstanding of Konva coordinate systems:**

In Konva, there are two coordinate spaces:
1. **Stage local coordinates** (world coords) - the coordinate system of shapes inside the Stage
2. **Absolute coordinates** (screen coords) - pixel positions on the canvas element

When the Stage has transforms (scale, position):
- `shape.x()` and `shape.y()` return **Stage local coordinates** (world coords)
- `shape.getAbsolutePosition()` returns **absolute coordinates** (screen coords)

**The original bug:** I incorrectly treated `shape.x()` as screen coordinates and applied coordinate conversion, which double-converted the values and produced garbage coordinates.

**The image disappearing bug:** Drag events were bubbling from the Rect to the Stage, causing BOTH the region and the entire canvas to move simultaneously.

## Solution

### 1. Fixed onDragEnd handler (canvas.tsx:587-604)

**Before (BROKEN):**
```typescript
onDragEnd={(e) => {
  const screenPos = { x: e.target.x(), y: e.target.y() }
  const worldPos = toWorld(stage, screenPos)  // ❌ Double conversion!
  updated[index] = {
    xmin: worldPos.x,  // Garbage values
    ymin: worldPos.y,
    xmax: worldPos.x + width,
    ymax: worldPos.y + height,
  }
}
```

**After (CORRECT):**
```typescript
onDragEnd={(e) => {
  e.cancelBubble = true  // ✅ Stop event bubbling to Stage
  // e.target.x() is ALREADY in world coords
  const newX = e.target.x()
  const newY = e.target.y()
  updated[index] = {
    xmin: newX,
    ymin: newY,
    xmax: newX + width,
    ymax: newY + height,
  }
}
```

### 2. Fixed handleTransformEnd (canvas.tsx:366-396)

**Before (BROKEN):**
```typescript
const screenPos = { x: node.x(), y: node.y() }
const worldPos = toWorld(stage, screenPos)  // ❌ Double conversion!
const worldWidth = (node.width() * scaleX) / stage.scaleX()  // ❌ Wrong!
```

**After (CORRECT):**
```typescript
// node.x(), node.y() are already in world coordinates
const x = node.x()
const y = node.y()
const width = node.width() * scaleX  // Already in world coords
const height = node.height() * scaleY
```

### 3. Added event.cancelBubble to prevent Stage movement

```typescript
onDragStart={(e) => {
  e.cancelBubble = true  // Stop bubbling
  // ...
}}
onDragMove={(e) => {
  e.cancelBubble = true  // Stop bubbling during drag
}}
onDragEnd={(e) => {
  e.cancelBubble = true  // Stop bubbling
  // ...
}}
```

### 4. Kept toWorld() for viewport→world conversion

The `toWorld()` helper is still needed for `handleAddTextArea()` because it converts from viewport screen pixels (DOM coordinates) to Stage world coordinates:

```typescript
const centerScreen = { x: containerSize.width / 2, y: containerSize.height / 2 }
const centerWorld = toWorld(stage, centerScreen)  // ✅ Correct usage
```

## Key Takeaways

| Operation | Input Coords | Output Coords | Conversion Needed? |
|-----------|--------------|---------------|-------------------|
| `shape.x()` | - | Stage local (world) | ❌ No |
| `shape.getAbsolutePosition()` | - | Absolute (screen) | ✅ Yes, use toWorld() |
| Viewport center | DOM pixels (screen) | - | ✅ Yes, use toWorld() |
| Drag handler `e.target.x()` | - | Stage local (world) | ❌ No |
| Transform `node.width() * scaleX` | - | Stage local (world) | ❌ No |

## Testing

1. ✅ Add area → appears at viewport center
2. ✅ Drag area → follows cursor smoothly
3. ✅ Release drag → image stays visible, region stays at dropped position
4. ✅ Resize area with transformer → correct bounding box
5. ✅ OCR on dragged area → no "invalid bounding box" errors
6. ✅ Zoom/pan → regions transform correctly with image

## Files Changed

- `next/components/canvas.tsx`: Fixed drag handlers, added cancelBubble
- Build: ✅ Clean (only unused `toScreen` warning)
