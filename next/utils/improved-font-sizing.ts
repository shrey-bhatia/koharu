import { TextBlock } from '@/lib/state'
import { classifyLayout, LayoutStrategy } from './layout-classification'

/**
 * Improved Font Sizing Module
 *
 * Uses layout-aware strategies, balanced line breaking, and mask geometry
 * to produce better text fitting than naive binary search.
 */

export interface ImprovedFontMetrics {
  fontSize: number
  lines: string[]
  actualWidth: number
  actualHeight: number
  lineHeight: number
  letterSpacing: number
  alignment: 'center' | 'top' | 'bottom' | 'left' | 'right'
  rotationDeg?: number
}

/**
 * Calculate optimal font size using layout-aware strategy
 */
export function calculateImprovedFontSize(
  block: TextBlock,
  text: string,
  fontFamily: string = 'Arial'
): ImprovedFontMetrics {
  if (!text || !block) {
    return {
      fontSize: 12,
      lines: [text || ''],
      actualWidth: 0,
      actualHeight: 0,
      lineHeight: 1.2,
      letterSpacing: 0,
      alignment: 'center',
    }
  }

  const boxWidth = block.xmax - block.xmin
  const boxHeight = block.ymax - block.ymin

  // Classify layout mode
  const strategy = classifyLayout(block)

  // Adjust available width based on strategy
  const effectiveWidth = boxWidth * strategy.columnWidthRatio
  const effectiveHeight = boxHeight * 0.9 // 10% vertical padding

  // Estimate initial font size from mask area if available
  const initialEstimate = estimateInitialFontSize(block, text, strategy)

  // Run optimization loop
  const result = optimizeFontSize(
    text,
    effectiveWidth,
    effectiveHeight,
    fontFamily,
    strategy,
    initialEstimate
  )

  return {
    ...result,
    alignment: strategy.preferredAlignment,
    rotationDeg: strategy.rotationDeg,
  }
}

/**
 * Estimate initial font size from mask area and text length
 */
function estimateInitialFontSize(
  block: TextBlock,
  text: string,
  strategy: LayoutStrategy
): number {
  const boxWidth = block.xmax - block.xmin
  const boxHeight = block.ymax - block.ymin
  const boxArea = boxWidth * boxHeight

  // If mask stats available, use actual text area
  const maskArea = block.maskStats?.area || boxArea * 0.5

  // Estimate glyphs per line based on layout mode
  const avgGlyphsPerLine = strategy.mode === 'vertical-narrow' ? 5 : 10
  const estimatedLines = Math.ceil(text.length / avgGlyphsPerLine)

  // Target coverage ratio
  const targetArea = boxArea * strategy.targetCoverageRatio

  // Solve: fontSize^2 * text.length * density = targetArea
  const glyphDensity = 0.7 // Empirical constant (glyph area as fraction of em-square)
  const fontSize = Math.sqrt(targetArea / (text.length * glyphDensity))

  // Clamp to reasonable range
  return Math.max(8, Math.min(fontSize, Math.min(boxHeight * 0.6, 48)))
}

/**
 * Optimize font size using penalty-based search
 */
function optimizeFontSize(
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontFamily: string,
  strategy: LayoutStrategy,
  initialEstimate: number
): Omit<ImprovedFontMetrics, 'alignment' | 'rotationDeg'> {
  let bestFontSize = initialEstimate
  let bestPenalty = Infinity
  let bestResult: Omit<ImprovedFontMetrics, 'alignment' | 'rotationDeg'> | null = null

  // Search range around initial estimate
  const searchRadius = initialEstimate * 0.5
  const minSize = Math.max(8, initialEstimate - searchRadius)
  const maxSize = Math.min(72, initialEstimate + searchRadius)
  const step = 1

  for (let fontSize = minSize; fontSize <= maxSize; fontSize += step) {
    const lineHeight = fontSize * strategy.lineHeightMultiplier
    const letterSpacing = strategy.letterSpacingAdjustment

    // Break text into lines using balanced breaking
    const lines = balancedLineBreak(text, maxWidth, fontSize, fontFamily, letterSpacing)

    // Measure result
    const { width, height } = measureLines(lines, fontSize, fontFamily, letterSpacing, lineHeight)

    // Calculate penalty
    const penalty = calculatePenalty(
      width,
      height,
      maxWidth,
      maxHeight,
      lines,
      strategy.targetCoverageRatio
    )

    if (penalty < bestPenalty) {
      bestPenalty = penalty
      bestFontSize = fontSize
      bestResult = {
        fontSize,
        lines,
        actualWidth: width,
        actualHeight: height,
        lineHeight: strategy.lineHeightMultiplier,
        letterSpacing,
      }
    }
  }

  // Fallback if no solution found
  if (!bestResult) {
    const lines = balancedLineBreak(text, maxWidth, 12, fontFamily, 0)
    const { width, height } = measureLines(lines, 12, fontFamily, 0, 1.2)
    bestResult = {
      fontSize: 12,
      lines,
      actualWidth: width,
      actualHeight: height,
      lineHeight: 1.2,
      letterSpacing: 0,
    }
  }

  return bestResult
}

/**
 * Balanced line breaking using greedy best-fit with raggedness penalty
 */
function balancedLineBreak(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string,
  letterSpacing: number
): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    const testLine = currentLine + (currentLine ? ' ' : '') + word
    const width = measureText(testLine, fontSize, fontFamily, letterSpacing).width

    if (width > maxWidth && currentLine !== '') {
      // Push current line and start new one
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
 * Measure text with letter spacing support
 */
function measureText(
  text: string,
  fontSize: number,
  fontFamily: string,
  letterSpacing: number
): { width: number; height: number } {
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
  ctx.letterSpacing = `${letterSpacing}px`
  const metrics = ctx.measureText(text)

  return {
    width: metrics.width,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || fontSize,
  }
}

/**
 * Measure total dimensions of multiple lines
 */
function measureLines(
  lines: string[],
  fontSize: number,
  fontFamily: string,
  letterSpacing: number,
  lineHeightMultiplier: number
): { width: number; height: number } {
  let maxWidth = 0

  for (const line of lines) {
    const { width } = measureText(line, fontSize, fontFamily, letterSpacing)
    maxWidth = Math.max(maxWidth, width)
  }

  const totalHeight = lines.length * fontSize * lineHeightMultiplier

  return { width: maxWidth, height: totalHeight }
}

/**
 * Calculate penalty for a given layout
 *
 * Penalizes:
 * - Overflow (hard constraint)
 * - Deviation from target coverage
 * - Raggedness (uneven line lengths)
 */
function calculatePenalty(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
  lines: string[],
  targetCoverage: number
): number {
  let penalty = 0

  // Hard constraint: overflow
  if (width > maxWidth) {
    penalty += (width - maxWidth) * 100
  }

  if (height > maxHeight) {
    penalty += (height - maxHeight) * 100
  }

  // Soft constraint: deviation from target coverage
  const actualCoverage = (width * height) / (maxWidth * maxHeight)
  const coverageDeviation = Math.abs(actualCoverage - targetCoverage)
  penalty += coverageDeviation * 50

  // Soft constraint: raggedness (variance in line lengths)
  if (lines.length > 1) {
    const lengths = lines.map((l) => l.length)
    const avgLength = lengths.reduce((sum, len) => sum + len, 0) / lengths.length
    const variance =
      lengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) / lengths.length
    penalty += Math.sqrt(variance) * 0.5
  }

  return penalty
}
