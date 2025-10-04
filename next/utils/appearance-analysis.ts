import { TextBlock, RGB, AppearanceMetadata, ColorPalette, MaskStats } from '@/lib/state'

/**
 * Appearance Analysis Module
 *
 * Analyzes text blocks to extract source colors, outlines, and geometry from the segmentation mask.
 * This module runs after detection and provides rich metadata for high-fidelity rendering.
 */

const MASK_SIZE = 1024 // Segmentation mask is always 1024x1024

/**
 * Analyze appearance for all text blocks using the segmentation mask
 */
export async function analyzeTextAppearance(
  image: ImageBitmap,
  mask: number[], // 1024x1024 grayscale segmentation mask
  textBlocks: TextBlock[]
): Promise<TextBlock[]> {
  return Promise.all(
    textBlocks.map(async (block) => {
      if (block.appearanceAnalyzed) {
        return block // Skip if already analyzed
      }

      const appearance = await analyzeBlock(image, mask, block)
      const maskStats = await analyzeMaskGeometry(mask, block, image.width, image.height)

      return {
        ...block,
        appearance,
        maskStats,
        appearanceAnalyzed: true,
      }
    })
  )
}

/**
 * Analyze a single text block
 */
async function analyzeBlock(
  image: ImageBitmap,
  mask: number[],
  block: TextBlock
): Promise<AppearanceMetadata> {
  // Extract local mask region for this block
  const localMask = extractLocalMask(mask, block, image.width, image.height)

  // Process mask to get text core and background regions
  const { textCore, background, outlineShell } = processMaskRegions(localMask)

  // Sample colors from the original image
  const textColorResult = await sampleTextColor(image, block, textCore)
  const backgroundColorResult = await sampleBackgroundColor(image, block, background)
  const outlineResult = await detectOutline(image, block, outlineShell)

  // Calculate overall confidence
  const confidence = Math.min(
    textColorResult.confidence,
    backgroundColorResult.confidence,
    outlineResult?.confidence ?? 1.0
  )

  return {
    sourceTextColor: textColorResult.color,
    sourceBackgroundColor: backgroundColorResult.color,
    sourceOutlineColor: outlineResult?.color,
    outlineWidthPx: outlineResult?.widthPx,
    textColorPalette: textColorResult.palette,
    backgroundColorPalette: backgroundColorResult.palette,
    confidence,
  }
}

/**
 * Extract mask region for a text block and resize to match block dimensions
 */
function extractLocalMask(
  fullMask: number[],
  block: TextBlock,
  imageWidth: number,
  imageHeight: number
): Uint8Array {
  const scaleX = MASK_SIZE / imageWidth
  const scaleY = MASK_SIZE / imageHeight

  // Map block coords to mask space
  const maskXmin = Math.floor(block.xmin * scaleX)
  const maskYmin = Math.floor(block.ymin * scaleY)
  const maskXmax = Math.ceil(block.xmax * scaleX)
  const maskYmax = Math.ceil(block.ymax * scaleY)

  const maskWidth = maskXmax - maskXmin
  const maskHeight = maskYmax - maskYmin

  const localMask = new Uint8Array(maskWidth * maskHeight)

  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      const maskX = Math.min(maskXmin + x, MASK_SIZE - 1)
      const maskY = Math.min(maskYmin + y, MASK_SIZE - 1)
      const maskIdx = maskY * MASK_SIZE + maskX
      localMask[y * maskWidth + x] = fullMask[maskIdx] || 0
    }
  }

  return localMask
}

/**
 * Process mask to identify text core, background, and outline regions
 */
function processMaskRegions(mask: Uint8Array): {
  textCore: Uint8Array
  background: Uint8Array
  outlineShell: Uint8Array
} {
  const width = Math.sqrt(mask.length)
  const height = width

  // Binary threshold
  const threshold = 30
  const binary = mask.map((v) => (v > threshold ? 255 : 0))

  // Dilate then erode to close gaps and isolate text core
  const dilated = dilate(binary, width, height, 2)
  const textCore = erode(dilated, width, height, 3)

  // Background = inverse of dilated mask
  const background = dilated.map((v) => (v > 0 ? 0 : 255))

  // Outline shell = dilated - eroded
  const outlineShell = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) {
    outlineShell[i] = dilated[i] > 0 && textCore[i] === 0 ? 255 : 0
  }

  return { textCore, background, outlineShell }
}

/**
 * Morphological dilation (expand mask)
 */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const result = new Uint8Array(mask.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxVal = 0
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = ny * width + nx
            maxVal = Math.max(maxVal, mask[idx])
          }
        }
      }
      result[y * width + x] = maxVal
    }
  }

  return result
}

/**
 * Morphological erosion (shrink mask)
 */
function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const result = new Uint8Array(mask.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minVal = 255
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = ny * width + nx
            minVal = Math.min(minVal, mask[idx])
          }
        }
      }
      result[y * width + x] = minVal
    }
  }

  return result
}

/**
 * Sample text color from the image using the text core mask
 */
async function sampleTextColor(
  image: ImageBitmap,
  block: TextBlock,
  textCore: Uint8Array
): Promise<{ color: RGB; palette: ColorPalette[]; confidence: number }> {
  const samples = await samplePixels(image, block, textCore)

  if (samples.length === 0) {
    // Fallback to detection class
    const fallbackColor = block.class === 0 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
    return { color: fallbackColor, palette: [], confidence: 0.5 }
  }

  const { dominantColor, palette, variance } = clusterColors(samples, 2)
  const confidence = Math.exp(-variance / 1000)

  return { color: dominantColor, palette, confidence }
}

/**
 * Sample background color from the image
 */
async function sampleBackgroundColor(
  image: ImageBitmap,
  block: TextBlock,
  background: Uint8Array
): Promise<{ color: RGB; palette: ColorPalette[]; confidence: number }> {
  const samples = await samplePixels(image, block, background)

  if (samples.length === 0) {
    return { color: { r: 255, g: 255, b: 255 }, palette: [], confidence: 0.3 }
  }

  const { dominantColor, palette, variance } = clusterColors(samples, 2)
  const confidence = Math.exp(-variance / 1000)

  return { color: dominantColor, palette, confidence }
}

/**
 * Detect outline color and width
 */
async function detectOutline(
  image: ImageBitmap,
  block: TextBlock,
  outlineShell: Uint8Array
): Promise<{ color: RGB; widthPx: number; confidence: number } | null> {
  const samples = await samplePixels(image, block, outlineShell)

  // Minimum coverage threshold
  const shellArea = outlineShell.filter((v) => v > 0).length
  if (shellArea < 10 || samples.length < 5) {
    return null // Not enough data for reliable outline detection
  }

  const { dominantColor, variance } = clusterColors(samples, 1)
  const confidence = Math.exp(-variance / 1000)

  // Estimate outline width from shell thickness
  const width = Math.sqrt(outlineShell.length)
  const estimatedWidthPx = Math.max(1, Math.round(shellArea / (4 * width)))

  return { color: dominantColor, widthPx: estimatedWidthPx, confidence }
}

/**
 * Sample pixels from the image within the masked region
 */
async function samplePixels(
  image: ImageBitmap,
  block: TextBlock,
  maskRegion: Uint8Array
): Promise<RGB[]> {
  const blockWidth = Math.ceil(block.xmax - block.xmin)
  const blockHeight = Math.ceil(block.ymax - block.ymin)

  // Create temporary canvas
  const canvas = new OffscreenCanvas(blockWidth, blockHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  // Draw the block region
  ctx.drawImage(
    image,
    Math.floor(block.xmin),
    Math.floor(block.ymin),
    blockWidth,
    blockHeight,
    0,
    0,
    blockWidth,
    blockHeight
  )

  const imageData = ctx.getImageData(0, 0, blockWidth, blockHeight)
  const pixels = imageData.data

  // Resize mask to match block dimensions
  const maskWidth = Math.sqrt(maskRegion.length)
  const maskHeight = maskWidth
  const samples: RGB[] = []

  for (let y = 0; y < blockHeight; y++) {
    for (let x = 0; x < blockWidth; x++) {
      // Map block pixel to mask space
      const maskX = Math.floor((x / blockWidth) * maskWidth)
      const maskY = Math.floor((y / blockHeight) * maskHeight)
      const maskIdx = maskY * maskWidth + maskX
      const maskValue = maskRegion[maskIdx]

      if (maskValue > 0) {
        const pixelIdx = (y * blockWidth + x) * 4
        samples.push({
          r: pixels[pixelIdx],
          g: pixels[pixelIdx + 1],
          b: pixels[pixelIdx + 2],
        })
      }
    }
  }

  // Subsample if too many pixels (performance)
  if (samples.length > 500) {
    const step = Math.ceil(samples.length / 500)
    return samples.filter((_, i) => i % step === 0)
  }

  return samples
}

/**
 * Cluster colors using k-means and return dominant color + palette
 */
function clusterColors(
  samples: RGB[],
  k: number
): { dominantColor: RGB; palette: ColorPalette[]; variance: number } {
  if (samples.length === 0) {
    return {
      dominantColor: { r: 255, g: 255, b: 255 },
      palette: [],
      variance: 0,
    }
  }

  if (k === 1 || samples.length < k * 3) {
    // Just compute median
    const medianColor = calculateMedianColor(samples)
    const variance = calculateColorVariance(samples, medianColor)
    return {
      dominantColor: medianColor,
      palette: [{ color: medianColor, percentage: 100 }],
      variance,
    }
  }

  // Simple k-means (max 10 iterations)
  const centroids = initializeCentroids(samples, k)

  for (let iter = 0; iter < 10; iter++) {
    const clusters = assignClusters(samples, centroids)
    const newCentroids = updateCentroids(samples, clusters, k)

    // Check convergence
    if (centroidsEqual(centroids, newCentroids)) {
      break
    }

    centroids.splice(0, centroids.length, ...newCentroids)
  }

  // Build palette
  const clusters = assignClusters(samples, centroids)
  const palette: ColorPalette[] = centroids.map((color, i) => {
    const count = clusters.filter((c) => c === i).length
    return { color, percentage: (count / samples.length) * 100 }
  })

  // Sort by percentage descending
  palette.sort((a, b) => b.percentage - a.percentage)

  const dominantColor = palette[0].color
  const variance = calculateColorVariance(samples, dominantColor)

  return { dominantColor, palette, variance }
}

/**
 * Initialize k-means centroids using k-means++ strategy
 */
function initializeCentroids(samples: RGB[], k: number): RGB[] {
  const centroids: RGB[] = []

  // Pick first centroid randomly
  centroids.push(samples[Math.floor(Math.random() * samples.length)])

  // Pick remaining centroids with probability proportional to distance squared
  for (let i = 1; i < k; i++) {
    const distances = samples.map((sample) => {
      const minDist = Math.min(
        ...centroids.map((c) => colorDistance(sample, c))
      )
      return minDist * minDist
    })

    const totalDist = distances.reduce((sum, d) => sum + d, 0)
    let rand = Math.random() * totalDist

    for (let j = 0; j < samples.length; j++) {
      rand -= distances[j]
      if (rand <= 0) {
        centroids.push(samples[j])
        break
      }
    }
  }

  return centroids
}

/**
 * Assign each sample to nearest centroid
 */
function assignClusters(samples: RGB[], centroids: RGB[]): number[] {
  return samples.map((sample) => {
    let minDist = Infinity
    let closestIdx = 0

    centroids.forEach((centroid, i) => {
      const dist = colorDistance(sample, centroid)
      if (dist < minDist) {
        minDist = dist
        closestIdx = i
      }
    })

    return closestIdx
  })
}

/**
 * Update centroids to mean of assigned samples
 */
function updateCentroids(samples: RGB[], clusters: number[], k: number): RGB[] {
  const newCentroids: RGB[] = []

  for (let i = 0; i < k; i++) {
    const clusterSamples = samples.filter((_, idx) => clusters[idx] === i)

    if (clusterSamples.length === 0) {
      // Empty cluster, keep old centroid or pick random sample
      newCentroids.push(samples[Math.floor(Math.random() * samples.length)])
    } else {
      const meanColor = {
        r: Math.round(clusterSamples.reduce((sum, s) => sum + s.r, 0) / clusterSamples.length),
        g: Math.round(clusterSamples.reduce((sum, s) => sum + s.g, 0) / clusterSamples.length),
        b: Math.round(clusterSamples.reduce((sum, s) => sum + s.b, 0) / clusterSamples.length),
      }
      newCentroids.push(meanColor)
    }
  }

  return newCentroids
}

/**
 * Check if centroids are equal
 */
function centroidsEqual(c1: RGB[], c2: RGB[]): boolean {
  return c1.every((color, i) => colorDistance(color, c2[i]) < 1)
}

/**
 * Euclidean distance between two colors
 */
function colorDistance(c1: RGB, c2: RGB): number {
  const dr = c1.r - c2.r
  const dg = c1.g - c2.g
  const db = c1.b - c2.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/**
 * Calculate median color (robust to outliers)
 */
function calculateMedianColor(samples: RGB[]): RGB {
  if (samples.length === 0) {
    return { r: 255, g: 255, b: 255 }
  }

  const rValues = samples.map((s) => s.r).sort((a, b) => a - b)
  const gValues = samples.map((s) => s.g).sort((a, b) => a - b)
  const bValues = samples.map((s) => s.b).sort((a, b) => a - b)

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
 * Analyze mask geometry using PCA
 */
async function analyzeMaskGeometry(
  mask: number[],
  block: TextBlock,
  imageWidth: number,
  imageHeight: number
): Promise<MaskStats> {
  // Extract local mask region
  const scaleX = MASK_SIZE / imageWidth
  const scaleY = MASK_SIZE / imageHeight

  const maskXmin = Math.floor(block.xmin * scaleX)
  const maskYmin = Math.floor(block.ymin * scaleY)
  const maskXmax = Math.ceil(block.xmax * scaleX)
  const maskYmax = Math.ceil(block.ymax * scaleY)

  // Collect mask pixel coordinates
  const points: [number, number][] = []
  let sumX = 0
  let sumY = 0

  for (let y = maskYmin; y < maskYmax && y < MASK_SIZE; y++) {
    for (let x = maskXmin; x < maskXmax && x < MASK_SIZE; x++) {
      const idx = y * MASK_SIZE + x
      if (mask[idx] > 30) {
        points.push([x, y])
        sumX += x
        sumY += y
      }
    }
  }

  const area = points.length
  const centroid: [number, number] = area > 0 ? [sumX / area, sumY / area] : [0, 0]

  // PCA for orientation
  let sumXX = 0
  let sumYY = 0
  let sumXY = 0

  for (const [x, y] of points) {
    const dx = x - centroid[0]
    const dy = y - centroid[1]
    sumXX += dx * dx
    sumYY += dy * dy
    sumXY += dx * dy
  }

  const covXX = sumXX / area
  const covYY = sumYY / area
  const covXY = sumXY / area

  // Eigenvalues via quadratic formula
  const trace = covXX + covYY
  const det = covXX * covYY - covXY * covXY
  const discriminant = Math.sqrt(trace * trace - 4 * det)

  const lambda1 = (trace + discriminant) / 2
  const lambda2 = (trace - discriminant) / 2

  // Orientation angle (in degrees)
  const orientationDeg = (Math.atan2(2 * covXY, covXX - covYY) * 180) / Math.PI / 2

  // Eccentricity (ratio of eigenvalues)
  const eccentricity = lambda2 > 0 ? lambda1 / lambda2 : 1

  return {
    area,
    centroid,
    orientationDeg,
    eccentricity,
  }
}
