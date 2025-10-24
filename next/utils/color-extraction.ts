import { TextBlock } from '@/lib/state'

export interface RGB {
  r: number
  g: number
  b: number
}

export interface ColorResult {
  backgroundColor: RGB
  textColor: RGB
  confidence: number // 0-1, based on color variance
}

type CachedCanvas = {
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

const CANVAS_CACHE = new WeakMap<ImageBitmap, CachedCanvas>()

function getOrCreateContext(image: ImageBitmap): CachedCanvas {
  const cached = CANVAS_CACHE.get(image)
  if (cached) {
    return cached
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Failed to get offscreen canvas context')
    ctx.drawImage(image, 0, 0)
    const cacheEntry: CachedCanvas = { ctx }
    CANVAS_CACHE.set(image, cacheEntry)
    return cacheEntry
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Failed to get canvas context')
    ctx.drawImage(image, 0, 0)
    const cacheEntry: CachedCanvas = { ctx }
    CANVAS_CACHE.set(image, cacheEntry)
    return cacheEntry
  }

  throw new Error('No canvas implementation available')
}

/**
 * Extract background color from border region around text bbox
 *
 * Strategy:
 * - Sample pixels from a ring around the bbox (not inside it)
 * - Use median instead of mean (robust to outliers like screentones)
 * - Calculate variance to assess confidence
 *
 * @param image - Source image to sample from
 * @param textBlock - Text block with bbox coordinates
 * @param padding - Border width to sample (default 10px)
 */
export async function extractBackgroundColor(
  image: ImageBitmap,
  textBlock: TextBlock,
  padding: number = 10
): Promise<ColorResult> {
  const { ctx } = getOrCreateContext(image)

  // Define sampling region (ring around bbox)
  const innerBox = {
    xmin: Math.max(0, Math.floor(textBlock.xmin)),
    ymin: Math.max(0, Math.floor(textBlock.ymin)),
    xmax: Math.min(image.width, Math.ceil(textBlock.xmax)),
    ymax: Math.min(image.height, Math.ceil(textBlock.ymax)),
  }

  const outerBox = {
    xmin: Math.max(0, innerBox.xmin - padding),
    ymin: Math.max(0, innerBox.ymin - padding),
    xmax: Math.min(image.width, innerBox.xmax + padding),
    ymax: Math.min(image.height, innerBox.ymax + padding),
  }

  const regionWidth = Math.max(0, outerBox.xmax - outerBox.xmin)
  const regionHeight = Math.max(0, outerBox.ymax - outerBox.ymin)

  if (regionWidth === 0 || regionHeight === 0) {
    return {
      backgroundColor: { r: 255, g: 255, b: 255 },
      textColor: textBlock.class === 0 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 },
      confidence: 0,
    }
  }

  const imageData = ctx.getImageData(outerBox.xmin, outerBox.ymin, regionWidth, regionHeight)
  const data = imageData.data

  const rValues: number[] = []
  const gValues: number[] = []
  const bValues: number[] = []

  for (let y = 0; y < regionHeight; y++) {
    const absoluteY = outerBox.ymin + y
    for (let x = 0; x < regionWidth; x++) {
      const absoluteX = outerBox.xmin + x
      const inInnerBox =
        absoluteX >= innerBox.xmin && absoluteX < innerBox.xmax &&
        absoluteY >= innerBox.ymin && absoluteY < innerBox.ymax

      if (inInnerBox) continue

      const offset = (y * regionWidth + x) * 4
      rValues.push(data[offset])
      gValues.push(data[offset + 1])
      bValues.push(data[offset + 2])
    }
  }

  const backgroundColor = calculateMedianFromChannels(rValues, gValues, bValues)

  // Determine text color from detection class
  // class 0 = black text, class 1 = white text
  const textColor: RGB = textBlock.class === 0
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 }

  const variance = calculateChannelVariance(rValues, gValues, bValues, backgroundColor)
  const confidence = Math.exp(-variance / 1000)

  return {
    backgroundColor,
    textColor,
    confidence,
  }
}

function calculateMedianFromChannels(rValues: number[], gValues: number[], bValues: number[]): RGB {
  const length = rValues.length
  if (length === 0) {
    return { r: 255, g: 255, b: 255 }
  }

  const mid = Math.floor(length / 2)

  const sortedR = [...rValues].sort((a, b) => a - b)
  const sortedG = [...gValues].sort((a, b) => a - b)
  const sortedB = [...bValues].sort((a, b) => a - b)

  return {
    r: sortedR[mid],
    g: sortedG[mid],
    b: sortedB[mid],
  }
}

function calculateChannelVariance(
  rValues: number[],
  gValues: number[],
  bValues: number[],
  mean: RGB
): number {
  const length = rValues.length
  if (length === 0) return 0

  let sumSquaredDiff = 0

  for (let i = 0; i < length; i++) {
    const dr = rValues[i] - mean.r
    const dg = gValues[i] - mean.g
    const db = bValues[i] - mean.b
    sumSquaredDiff += dr * dr + dg * dg + db * db
  }

  return sumSquaredDiff / length
}

/**
 * Convert RGB to hex string
 */
export function rgbToHex(color: RGB): string {
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
}

/**
 * Convert hex string to RGB
 */
export function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 0, g: 0, b: 0 }
}

/**
 * RGB to CSS string
 */
export function rgbToString(color: RGB): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}
