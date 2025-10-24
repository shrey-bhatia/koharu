import { TextBlock } from '@/lib/state'

export interface BBoxLike {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

export interface CompositingOptions {
  featherRadius?: number
  autoSeamFix?: boolean
  seamThreshold?: number
  precomputedMask?: Uint8Array
}

const maskCropCache = new WeakMap<Uint8Array, Map<string, Uint8Array>>()

export async function compositeMaskedRegion(
  baseCtx: OffscreenCanvasRenderingContext2D,
  inpaintedCrop: ImageBitmap,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  _textBlock: TextBlock,
  fullMask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  origWidth: number,
  origHeight: number,
  paddedBBox: BBoxLike,
  options: CompositingOptions = {}
) {
  const {
    featherRadius = 5,
    autoSeamFix = false,
    seamThreshold = 30,
    precomputedMask,
  } = options

  const maskRegion = precomputedMask ?? extractMaskRegion(
    fullMask,
    maskWidth,
    maskHeight,
    paddedBBox,
    origWidth,
    origHeight,
    cropWidth,
    cropHeight
  )

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
    const maskedImageData = createFeatheredAlpha(
      inpaintedCrop,
      maskRegion,
      cropWidth,
      cropHeight,
      featherRadius
    )

    const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
    const tempCtx = tempCanvas.getContext('2d')!
    tempCtx.putImageData(maskedImageData, 0, 0)

    baseCtx.drawImage(tempCanvas, cropX, cropY)
  }
}

function extractMaskRegion(
  fullMask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  paddedBBox: BBoxLike,
  origWidth: number,
  origHeight: number,
  targetWidth: number,
  targetHeight: number
): Uint8Array {
  const cache = getMaskCache(fullMask)
  const cacheKey = `${Math.round(paddedBBox.xmin)}:${Math.round(paddedBBox.ymin)}:${Math.round(paddedBBox.xmax)}:${Math.round(paddedBBox.ymax)}:${targetWidth}x${targetHeight}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return cached
  }

  const scaleX = maskWidth / origWidth
  const scaleY = maskHeight / origHeight

  const maskXmin = Math.floor(paddedBBox.xmin * scaleX)
  const maskYmin = Math.floor(paddedBBox.ymin * scaleY)
  const maskXmax = Math.min(Math.ceil(paddedBBox.xmax * scaleX), maskWidth)
  const maskYmax = Math.min(Math.ceil(paddedBBox.ymax * scaleY), maskHeight)

  const result = new Uint8Array(targetWidth * targetHeight)
  const spanX = Math.max(maskXmax - maskXmin, 1)
  const spanY = Math.max(maskYmax - maskYmin, 1)

  for (let y = 0; y < targetHeight; y++) {
    const maskY = Math.min(
      maskYmax - 1,
      maskYmin + Math.floor((y / Math.max(targetHeight - 1, 1)) * (spanY - 1))
    )

    for (let x = 0; x < targetWidth; x++) {
      const maskX = Math.min(
        maskXmax - 1,
        maskXmin + Math.floor((x / Math.max(targetWidth - 1, 1)) * (spanX - 1))
      )

      const maskIdx = maskY * maskWidth + maskX
      result[y * targetWidth + x] = fullMask[maskIdx] || 0
    }
  }

  cache.set(cacheKey, result)
  return result
}

function getMaskCache(mask: Uint8Array): Map<string, Uint8Array> {
  let cached = maskCropCache.get(mask)
  if (!cached) {
    cached = new Map<string, Uint8Array>()
    maskCropCache.set(mask, cached)
  }
  return cached
}

function createFeatheredAlpha(
  inpaintedCrop: ImageBitmap,
  maskRegion: Uint8Array,
  width: number,
  height: number,
  featherRadius: number
): ImageData {
  const tempCanvas = new OffscreenCanvas(width, height)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.drawImage(inpaintedCrop, 0, 0, width, height)
  const inpaintedData = tempCtx.getImageData(0, 0, width, height)
  const pixels = inpaintedData.data

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskValue = maskRegion[y * width + x]
      const idx = (y * width + x) * 4

      if (maskValue < 30) {
        pixels[idx + 3] = 0
        continue
      }

      const distToLeft = x
      const distToRight = width - x - 1
      const distToTop = y
      const distToBottom = height - y - 1
      const distToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom)

      let alphaValue = maskValue
      if (distToEdge < featherRadius) {
        const edgeFactor = distToEdge / featherRadius
        const smoothFactor = 0.5 - 0.5 * Math.cos(edgeFactor * Math.PI)
        alphaValue = Math.floor(maskValue * smoothFactor)
      }

      pixels[idx + 3] = alphaValue
    }
  }

  return inpaintedData
}

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
  const baseImageData = baseCtx.getImageData(cropX, cropY, cropWidth, cropHeight)
  const basePixels = baseImageData.data

  const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.drawImage(inpaintedCrop, 0, 0, cropWidth, cropHeight)
  const inpaintData = tempCtx.getImageData(0, 0, cropWidth, cropHeight)
  const inpaintPixels = inpaintData.data

  let totalVariance = 0
  let boundaryCount = 0

  for (let y = 1; y < cropHeight - 1; y++) {
    for (let x = 1; x < cropWidth - 1; x++) {
      const maskVal = maskRegion[y * cropWidth + x]

      const isEdge = maskVal > 30 && (
        maskRegion[(y - 1) * cropWidth + x] < 30 ||
        maskRegion[(y + 1) * cropWidth + x] < 30 ||
        maskRegion[y * cropWidth + (x - 1)] < 30 ||
        maskRegion[y * cropWidth + (x + 1)] < 30
      )

      if (!isEdge) continue

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
  const baseImageData = baseCtx.getImageData(cropX, cropY, cropWidth, cropHeight)
  const basePixels = baseImageData.data

  const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
  const tempCtx = tempCanvas.getContext('2d')!
  tempCtx.drawImage(inpaintedCrop, 0, 0, cropWidth, cropHeight)
  const inpaintData = tempCtx.getImageData(0, 0, cropWidth, cropHeight)
  const inpaintPixels = inpaintData.data

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const idx = (y * cropWidth + x) * 4
      const maskVal = maskRegion[y * cropWidth + x]

      if (maskVal < 30) {
        continue
      }

      const distToEdge = computeDistanceToEdge(x, y, cropWidth, cropHeight, maskRegion)

      if (distToEdge < featherRadius) {
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
        basePixels[idx] = inpaintPixels[idx]
        basePixels[idx + 1] = inpaintPixels[idx + 1]
        basePixels[idx + 2] = inpaintPixels[idx + 2]
      }
    }
  }

  baseCtx.putImageData(baseImageData, cropX, cropY)
}

function computeDistanceToEdge(
  x: number,
  y: number,
  width: number,
  height: number,
  mask: Uint8Array
): number {
  let minDist = Infinity

  for (let r = 1; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx
        const ny = y + dy

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

        const nIdx = ny * width + nx
        if (mask[nIdx] < 30) {
          const dist = Math.sqrt(dx * dx + dy * dy)
          minDist = Math.min(minDist, dist)
        }
      }
    }

    if (minDist < Infinity) break
  }

  return minDist === Infinity ? 10 : minDist
}
