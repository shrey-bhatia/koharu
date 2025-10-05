export interface FontMetrics {
  fontSize: number
  lines: string[]
  actualWidth: number
  actualHeight: number
}

/**
 * Calculate optimal font size to fit text in bbox
 * Uses binary search for efficiency
 *
 * @param text - Text to fit
 * @param boxWidth - Available width
 * @param boxHeight - Available height
 * @param fontFamily - Font family to use
 * @param padding - Padding ratio (0.1 = 10% on all sides)
 * @returns Font metrics with optimal size and wrapped lines
 */
export function calculateOptimalFontSize(
  text: string,
  boxWidth: number,
  boxHeight: number,
  fontFamily: string = 'Arial',
  padding: number = 0.1
): FontMetrics {

  if (!text || boxWidth <= 0 || boxHeight <= 0) {
    return {
      fontSize: 12,
      lines: [text || ''],
      actualWidth: 0,
      actualHeight: 0,
    }
  }

  const availableWidth = boxWidth * (1 - 2 * padding)
  const availableHeight = boxHeight * (1 - 2 * padding)

  let minSize = 8
  let maxSize = Math.min(boxHeight * 0.8, 72) // Cap at 72pt

  let bestFit: FontMetrics | null = null

  // Binary search for optimal size
  while (maxSize - minSize > 1) {
    const fontSize = Math.floor((minSize + maxSize) / 2)

    // Try wrapping text at this size
    const lines = wrapText(text, availableWidth, fontSize, fontFamily)
    const metrics = measureMultilineText(lines, fontSize, fontFamily)

    const fitsWidth = metrics.width <= availableWidth
    const fitsHeight = metrics.height <= availableHeight

    if (fitsWidth && fitsHeight) {
      // This size works, try larger
      bestFit = {
        fontSize,
        lines,
        actualWidth: metrics.width,
        actualHeight: metrics.height,
      }
      minSize = fontSize
    } else {
      // Too big, try smaller
      maxSize = fontSize
    }
  }

  if (!bestFit) {
    // Fallback to minimum size
    const lines = wrapText(text, availableWidth, minSize, fontFamily)
    const metrics = measureMultilineText(lines, minSize, fontFamily)
    bestFit = {
      fontSize: minSize,
      lines,
      actualWidth: metrics.width,
      actualHeight: metrics.height,
    }
  }

  return bestFit
}

/**
 * Wrap text to fit within maxWidth
 * Breaks on word boundaries
 */
function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string
): string[] {

  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    const testLine = currentLine + (currentLine ? ' ' : '') + word
    const metrics = measureText(testLine, fontSize, fontFamily)

    if (metrics.width > maxWidth && currentLine !== '') {
      // Line too long, push current and start new
      lines.push(currentLine)
      currentLine = word
    } else {
      currentLine = testLine
    }
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines.length > 0 ? lines : [text]
}

/**
 * Measure single line of text
 */
function measureText(
  text: string,
  fontSize: number,
  fontFamily: string
): { width: number; height: number } {

  // Create temporary canvas for measurement
  if (typeof document === 'undefined') {
    // SSR fallback
    return { width: text.length * fontSize * 0.6, height: fontSize }
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { width: text.length * fontSize * 0.6, height: fontSize }
  }

  ctx.font = `${fontSize}px ${fontFamily}`
  const metrics = ctx.measureText(text)

  return {
    width: metrics.width,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || fontSize,
  }
}

/**
 * Measure multiline text block
 */
function measureMultilineText(
  lines: string[],
  fontSize: number,
  fontFamily: string
): { width: number; height: number } {

  let maxWidth = 0
  const lineHeight = fontSize * 1.2 // Standard line height multiplier

  for (const line of lines) {
    const metrics = measureText(line, fontSize, fontFamily)
    maxWidth = Math.max(maxWidth, metrics.width)
  }

  const totalHeight = lines.length * lineHeight

  return { width: maxWidth, height: totalHeight }
}
