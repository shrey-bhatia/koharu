import { TextBlock } from '@/lib/state'

export async function compositeMaskedRegion(
  baseCtx: OffscreenCanvasRenderingContext2D,
  inpaintedCrop: ImageBitmap,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  textBlock: TextBlock,
  fullMask: number[],
  origWidth: number,
  origHeight: number,
  featherRadius: number = 5
) {
  // Step 1: Extract mask region for this text block
  const maskRegion = extractMaskRegion(
    fullMask,
    textBlock,
    origWidth,
    origHeight,
    cropWidth,
    cropHeight
  )

  // Step 2: Create feathered alpha-masked ImageData with inpainted pixels
  const maskedImageData = createFeatheredAlpha(
    inpaintedCrop,
    maskRegion,
    cropWidth,
    cropHeight,
    featherRadius
  )

  // Step 3: Create temporary canvas to hold the masked inpaint
  const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.putImageData(maskedImageData, 0, 0)

  // Step 4: Composite onto base canvas with default 'source-over' blending
  baseCtx.drawImage(tempCanvas, cropX, cropY)
}

function extractMaskRegion(
  fullMask: number[],
  textBlock: TextBlock,
  origWidth: number,
  origHeight: number,
  targetWidth: number,
  targetHeight: number
): Uint8Array {
  const scaleX = 1024 / origWidth
  const scaleY = 1024 / origHeight

  // Map text block to mask coordinates
  const maskXmin = Math.floor(textBlock.xmin * scaleX)
  const maskYmin = Math.floor(textBlock.ymin * scaleY)

  // Extract and resize mask region to match crop dimensions
  const maskRegion = new Uint8Array(targetWidth * targetHeight)

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      // Map crop pixel back to mask space
      const maskX = Math.floor(maskXmin + (x / targetWidth) * (textBlock.xmax - textBlock.xmin) * scaleX)
      const maskY = Math.floor(maskYmin + (y / targetHeight) * (textBlock.ymax - textBlock.ymin) * scaleY)

      // Clamp to mask bounds
      const clampedX = Math.min(Math.max(maskX, 0), 1023)
      const clampedY = Math.min(Math.max(maskY, 0), 1023)

      const maskIdx = clampedY * 1024 + clampedX
      maskRegion[y * targetWidth + x] = fullMask[maskIdx] || 0
    }
  }

  return maskRegion
}

function createFeatheredAlpha(
  inpaintedCrop: ImageBitmap,
  maskRegion: Uint8Array,
  width: number,
  height: number,
  featherRadius: number
): ImageData {
  // Create a canvas to get the inpainted pixels
  const tempCanvas = new OffscreenCanvas(width, height)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.drawImage(inpaintedCrop, 0, 0, width, height)
  const inpaintedData = tempCtx.getImageData(0, 0, width, height)
  const pixels = inpaintedData.data

  // Apply feathered alpha to the inpainted pixels directly
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskValue = maskRegion[y * width + x]
      const idx = (y * width + x) * 4

      // Skip if not text (mask value < 30) - make fully transparent
      if (maskValue < 30) {
        pixels[idx + 3] = 0 // A - fully transparent (preserve RGB from inpaint)
        continue
      }

      // Calculate distance to nearest edge for feathering
      const distToLeft = x
      const distToRight = width - x - 1
      const distToTop = y
      const distToBottom = height - y - 1
      const distToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom)

      // Apply feathering to alpha channel only
      let alphaValue = maskValue
      if (distToEdge < featherRadius) {
        // Smooth falloff using cosine easing
        const edgeFactor = distToEdge / featherRadius
        const smoothFactor = 0.5 - 0.5 * Math.cos(edgeFactor * Math.PI)
        alphaValue = Math.floor(maskValue * smoothFactor)
      }

      // Keep RGB from inpainted crop, only modify alpha
      pixels[idx + 3] = alphaValue
    }
  }

  return inpaintedData
}
