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

  // Create temporary canvas to read pixels
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  ctx.drawImage(image, 0, 0)

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

  // Sample pixels from border region (ring between inner and outer box)
  const samples: RGB[] = []

  // Top edge
  for (let x = outerBox.xmin; x < outerBox.xmax; x++) {
    for (let y = outerBox.ymin; y < innerBox.ymin; y++) {
      samples.push(getPixel(ctx, x, y))
    }
  }

  // Bottom edge
  for (let x = outerBox.xmin; x < outerBox.xmax; x++) {
    for (let y = innerBox.ymax; y < outerBox.ymax; y++) {
      samples.push(getPixel(ctx, x, y))
    }
  }

  // Left edge (excluding corners already sampled)
  for (let x = outerBox.xmin; x < innerBox.xmin; x++) {
    for (let y = innerBox.ymin; y < innerBox.ymax; y++) {
      samples.push(getPixel(ctx, x, y))
    }
  }

  // Right edge (excluding corners already sampled)
  for (let x = innerBox.xmax; x < outerBox.xmax; x++) {
    for (let y = innerBox.ymin; y < innerBox.ymax; y++) {
      samples.push(getPixel(ctx, x, y))
    }
  }

  // Calculate median color (robust to outliers)
  const backgroundColor = calculateMedianColor(samples)

  // Determine text color from detection class
  // class 0 = black text, class 1 = white text
  const textColor: RGB = textBlock.class === 0
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 }

  // Calculate confidence based on color variance
  const variance = calculateColorVariance(samples, backgroundColor)
  const confidence = Math.exp(-variance / 1000) // Lower variance = higher confidence

  return {
    backgroundColor,
    textColor,
    confidence,
  }
}

/**
 * Get pixel color at specific coordinate
 */
function getPixel(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number
): RGB {
  const imageData = ctx.getImageData(x, y, 1, 1)
  return {
    r: imageData.data[0],
    g: imageData.data[1],
    b: imageData.data[2],
  }
}

/**
 * Calculate median color from samples
 * More robust than mean for manga (screentones, gradients)
 */
function calculateMedianColor(samples: RGB[]): RGB {
  if (samples.length === 0) {
    return { r: 255, g: 255, b: 255 } // Default white
  }

  // Sort each channel independently
  const rValues = samples.map(s => s.r).sort((a, b) => a - b)
  const gValues = samples.map(s => s.g).sort((a, b) => a - b)
  const bValues = samples.map(s => s.b).sort((a, b) => a - b)

  const mid = Math.floor(samples.length / 2)

  return {
    r: rValues[mid],
    g: gValues[mid],
    b: bValues[mid],
  }
}

/**
 * Calculate color variance for confidence metric
 */
function calculateColorVariance(samples: RGB[], mean: RGB): number {
  if (samples.length === 0) return 0

  let sumSquaredDiff = 0

  for (const sample of samples) {
    const dr = sample.r - mean.r
    const dg = sample.g - mean.g
    const db = sample.b - mean.b
    sumSquaredDiff += dr * dr + dg * dg + db * db
  }

  return sumSquaredDiff / samples.length
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
