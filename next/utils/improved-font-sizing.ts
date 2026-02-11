import { TextBlock } from '@/lib/state'
import { classifyLayout, LayoutStrategy } from './layout-classification'

/**
 * Improved Font Sizing Module v2
 *
 * Key improvements over v1:
 * - Character-level line breaking for CJK text (no spaces needed)
 * - Wider search range (8px to box-proportional max, not capped at 72px)
 * - Tighter binary search that maximizes text size without overflow
 * - Reduced padding for better area utilization
 * - Smart word+character hybrid breaking
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

type MeasurementContext = {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
}

const measurementContext = createMeasurementContext()
const measurementCache = new Map<string, { width: number; height: number }>()
const MAX_MEASUREMENT_CACHE_ENTRIES = 2000

function createMeasurementContext(): MeasurementContext | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(1, 1)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      return { ctx }
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx) {
      return { ctx }
    }
  }

  return null
}

/**
 * Detect if text contains CJK characters that can break at any point
 */
function hasCJK(text: string): boolean {
  return /[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(text)
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

  // Use tighter padding for better area utilization
  const effectiveWidth = boxWidth * strategy.columnWidthRatio
  const effectiveHeight = boxHeight * 0.92 // Reduced from 0.9 → 8% vertical padding

  // Run optimization — wider search range, no cap at 72px
  const result = optimizeFontSize(
    text,
    effectiveWidth,
    effectiveHeight,
    fontFamily,
    strategy
  )

  return {
    ...result,
    alignment: strategy.preferredAlignment,
    rotationDeg: strategy.rotationDeg,
  }
}

/**
 * Optimize font size using full-range binary search.
 * 
 * Strategy: find the largest font size where text fits within the box.
 * No initial estimate needed — binary search over the full plausible range is fast (< 15 iterations).
 */
function optimizeFontSize(
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontFamily: string,
  strategy: LayoutStrategy
): Omit<ImprovedFontMetrics, 'alignment' | 'rotationDeg'> {
  const letterSpacing = strategy.letterSpacingAdjustment
  const lineHeightMultiplier = strategy.lineHeightMultiplier

  // Dynamic max: for a box of height H, the max font size is ~H (single line fills the box).
  // For width W, a single character could be up to W.
  const dynamicMax = Math.min(maxHeight, maxWidth, 200)
  const minSize = 6
  const maxSize = Math.max(minSize + 1, Math.floor(dynamicMax))

  // Binary search: find the largest fontSize that fits
  let low = minSize
  let high = maxSize
  let bestFit: { fontSize: number; lines: string[]; width: number; height: number } | null = null

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const lines = smartLineBreak(text, maxWidth, mid, fontFamily, letterSpacing)
    const { width, height } = measureLines(lines, mid, fontFamily, letterSpacing, lineHeightMultiplier)

    if (width <= maxWidth && height <= maxHeight) {
      bestFit = { fontSize: mid, lines, width, height }
      low = mid + 1 // Try larger
    } else {
      high = mid - 1 // Too big, try smaller
    }
  }

  // Fallback: if nothing fits, use minimum size
  if (!bestFit) {
    const lines = smartLineBreak(text, maxWidth, minSize, fontFamily, letterSpacing)
    const { width, height } = measureLines(lines, minSize, fontFamily, letterSpacing, lineHeightMultiplier)
    bestFit = { fontSize: minSize, lines, width, height }
  }

  return {
    fontSize: bestFit.fontSize,
    lines: bestFit.lines,
    actualWidth: bestFit.width,
    actualHeight: bestFit.height,
    lineHeight: lineHeightMultiplier,
    letterSpacing,
  }
}

/**
 * Smart line breaking that handles both Western text (break on spaces)
 * and CJK text (break at any character boundary).
 * 
 * For mixed text, words are broken on spaces first, then individual
 * characters within a "word" (CJK segment) can be broken if the word
 * is too wide for the line.
 */
function smartLineBreak(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string,
  letterSpacing: number
): string[] {
  const lines: string[] = []
  
  // Split into tokens: spaces create word boundaries, but each CJK character
  // is also a valid break point. We split into segments that are either
  // space-delimited words or individual CJK characters.
  const tokens = tokenize(text)
  let currentLine = ''

  for (const token of tokens) {
    const testLine = currentLine + token
    const testWidth = measureText(testLine, fontSize, fontFamily, letterSpacing).width

    if (testWidth > maxWidth && currentLine !== '') {
      lines.push(currentLine)
      // If the token itself is wider than maxWidth (very long word), 
      // break it character by character
      if (measureText(token, fontSize, fontFamily, letterSpacing).width > maxWidth) {
        const charLines = breakLongToken(token, maxWidth, fontSize, fontFamily, letterSpacing)
        // All but last go as full lines
        for (let i = 0; i < charLines.length - 1; i++) {
          lines.push(charLines[i])
        }
        currentLine = charLines[charLines.length - 1]
      } else {
        currentLine = token
      }
    } else if (testWidth > maxWidth && currentLine === '') {
      // First token and already too wide — break it char by char
      const charLines = breakLongToken(token, maxWidth, fontSize, fontFamily, letterSpacing)
      for (let i = 0; i < charLines.length - 1; i++) {
        lines.push(charLines[i])
      }
      currentLine = charLines[charLines.length - 1]
    } else {
      currentLine = testLine
    }
  }

  if (currentLine) lines.push(currentLine)
  return lines.length > 0 ? lines : [text]
}

/**
 * Tokenize text into breakable segments.
 * CJK characters become individual tokens. Spaces attach to the preceding word.
 * "Hello 世界 test" → ["Hello ", "世", "界", " test"]
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  
  // CJK Unicode ranges
  const isCJK = (ch: string) => /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch)
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (isCJK(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      tokens.push(ch)
    } else if (ch === ' ') {
      current += ch
      tokens.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  
  return tokens
}

/**
 * Break a single token (word or CJK run) into lines that fit maxWidth.
 */
function breakLongToken(
  token: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string,
  letterSpacing: number
): string[] {
  const lines: string[] = []
  let current = ''
  
  for (const ch of token) {
    const test = current + ch
    if (measureText(test, fontSize, fontFamily, letterSpacing).width > maxWidth && current) {
      lines.push(current)
      current = ch
    } else {
      current = test
    }
  }
  if (current) lines.push(current)
  return lines
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
  if (!measurementContext) {
    // SSR fallback
    return { width: text.length * fontSize * 0.6, height: fontSize }
  }

  const key = `${fontFamily}|${fontSize}|${letterSpacing}|${text}`
  const cached = measurementCache.get(key)
  if (cached) {
    return cached
  }

  const { ctx } = measurementContext
  ctx.font = `${fontSize}px ${fontFamily}`

  if ('letterSpacing' in ctx) {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${letterSpacing}px`
  }

  const metrics = ctx.measureText(text)
  const result = {
    width: metrics.width,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent || fontSize,
  }

  if (measurementCache.size >= MAX_MEASUREMENT_CACHE_ENTRIES) {
    measurementCache.clear()
  }

  measurementCache.set(key, result)
  return result
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
