import { TextBlock } from '@/lib/state'

export interface CompositingOptions {
  featherRadius?: number
  autoSeamFix?: boolean // Enable automatic seam fix for high-variance edges
  seamThreshold?: number // Variance threshold for triggering seam fix
}

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
  options: CompositingOptions = {}
) {
  const {
    featherRadius = 5,
    autoSeamFix = false,
    seamThreshold = 30,
  } = options

  // Step 1: Extract mask region for this text block
  const maskRegion = extractMaskRegion(
    fullMask,
    textBlock,
    origWidth,
    origHeight,
    cropWidth,
    cropHeight
  )

  // Step 2: Detect edge variance to determine if seam fix is needed
  const needsSeamFix = autoSeamFix && detectHighEdgeVariance(
    baseCtx,
    inpaintedCrop,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    maskRegion,
    seamThreshold
  )

  if (needsSeamFix) {
    console.log(`Block at (${cropX}, ${cropY}): High edge variance detected, using gradient-domain blending`)
    // Use Poisson blending approximation (gradient-domain composite)
    await compositeWithGradientBlend(
      baseCtx,
      inpaintedCrop,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      maskRegion,
      featherRadius
    )
  } else {
    // Step 3: Create feathered alpha-masked ImageData with inpainted pixels
    const maskedImageData = createFeatheredAlpha(
      inpaintedCrop,
      maskRegion,
      cropWidth,
      cropHeight,
      featherRadius
    )

    // Step 4: Create temporary canvas to hold the masked inpaint
    const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
    const tempCtx = tempCanvas.getContext('2d')!
    tempCtx.putImageData(maskedImageData, 0, 0)

    // Step 5: Composite onto base canvas with default 'source-over' blending
    baseCtx.drawImage(tempCanvas, cropX, cropY)
  }
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

/**
 * Detect high edge variance across mask boundary
 * Returns true if the edge has significant color gradients/textures
 */
function detectHighEdgeVariance(
  baseCtx: OffscreenCanvasRenderingContext2D,
  inpaintedCrop: ImageBitmap,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  maskRegion: Uint8Array,
  threshold: number
): boolean {
  // Sample pixels along mask boundary from base image
  const baseImageData = baseCtx.getImageData(cropX, cropY, cropWidth, cropHeight)
  const basePixels = baseImageData.data

  // Get inpainted pixels
  const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.drawImage(inpaintedCrop, 0, 0, cropWidth, cropHeight)
  const inpaintData = tempCtx.getImageData(0, 0, cropWidth, cropHeight)
  const inpaintPixels = inpaintData.data

  // Find boundary pixels (mask transition zone)
  let totalVariance = 0
  let boundaryCount = 0

  for (let y = 1; y < cropHeight - 1; y++) {
    for (let x = 1; x < cropWidth - 1; x++) {
      const maskVal = maskRegion[y * cropWidth + x]

      // Check if this is a boundary pixel (mask edge)
      const isEdge = maskVal > 30 && (
        maskRegion[(y - 1) * cropWidth + x] < 30 ||
        maskRegion[(y + 1) * cropWidth + x] < 30 ||
        maskRegion[y * cropWidth + (x - 1)] < 30 ||
        maskRegion[y * cropWidth + (x + 1)] < 30
      )

      if (!isEdge) continue

      // Calculate color difference between base and inpaint at boundary
      const idx = (y * cropWidth + x) * 4
      const dr = basePixels[idx] - inpaintPixels[idx]
      const dg = basePixels[idx + 1] - inpaintPixels[idx + 1]
      const db = basePixels[idx + 2] - inpaintPixels[idx + 2]
      const colorDiff = Math.sqrt(dr * dr + dg * dg + db * db)

      totalVariance += colorDiff
      boundaryCount++
    }
  }

  if (boundaryCount === 0) return false

  const avgVariance = totalVariance / boundaryCount
  return avgVariance > threshold
}

/**
 * Composite using gradient-domain blending (simplified Poisson)
 * This reduces seams by blending gradients rather than colors
 */
async function compositeWithGradientBlend(
  baseCtx: OffscreenCanvasRenderingContext2D,
  inpaintedCrop: ImageBitmap,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  maskRegion: Uint8Array,
  featherRadius: number
) {
  // Get base image data
  const baseImageData = baseCtx.getImageData(cropX, cropY, cropWidth, cropHeight)
  const basePixels = baseImageData.data

  // Get inpainted pixels
  const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.drawImage(inpaintedCrop, 0, 0, cropWidth, cropHeight)
  const inpaintData = tempCtx.getImageData(0, 0, cropWidth, cropHeight)
  const inpaintPixels = inpaintData.data

  // Simplified gradient-domain blend: mix colors near boundary
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const idx = (y * cropWidth + x) * 4
      const maskVal = maskRegion[y * cropWidth + x]

      if (maskVal < 30) {
        // Outside mask, keep base
        continue
      }

      // Calculate distance to mask edge
      const distToEdge = computeDistanceToEdge(x, y, cropWidth, cropHeight, maskRegion)

      if (distToEdge < featherRadius) {
        // Blend zone: mix base and inpaint with smooth transition
        const blendFactor = distToEdge / featherRadius
        const smoothBlend = 0.5 - 0.5 * Math.cos(blendFactor * Math.PI)

        basePixels[idx] = Math.round(
          basePixels[idx] * (1 - smoothBlend) + inpaintPixels[idx] * smoothBlend
        )
        basePixels[idx + 1] = Math.round(
          basePixels[idx + 1] * (1 - smoothBlend) + inpaintPixels[idx + 1] * smoothBlend
        )
        basePixels[idx + 2] = Math.round(
          basePixels[idx + 2] * (1 - smoothBlend) + inpaintPixels[idx + 2] * smoothBlend
        )
      } else {
        // Inner region: full inpaint
        basePixels[idx] = inpaintPixels[idx]
        basePixels[idx + 1] = inpaintPixels[idx + 1]
        basePixels[idx + 2] = inpaintPixels[idx + 2]
      }
    }
  }

  // Write blended result back
  baseCtx.putImageData(baseImageData, cropX, cropY)
}

/**
 * Compute approximate distance to mask edge
 */
function computeDistanceToEdge(
  x: number,
  y: number,
  width: number,
  height: number,
  mask: Uint8Array
): number {
  let minDist = Infinity

  // Check neighbors in expanding radius
  for (let r = 1; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx
        const ny = y + dy

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

        const nIdx = ny * width + nx
        if (mask[nIdx] < 30) {
          // Found edge
          const dist = Math.sqrt(dx * dx + dy * dy)
          minDist = Math.min(minDist, dist)
        }
      }
    }

    if (minDist < Infinity) break
  }

  return minDist === Infinity ? 10 : minDist
}
