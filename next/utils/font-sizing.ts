export interface FontMetrics {
  fontSize: number
  lines: string[]
  actualWidth: number
  actualHeight: number
}

// Shared measurement context — avoids creating a new canvas per measureText call
let _sharedCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

function getSharedCtx(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  if (_sharedCtx) return _sharedCtx
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(1, 1)
    _sharedCtx = c.getContext('2d')
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    _sharedCtx = c.getContext('2d')
  }
  return _sharedCtx
}

/**
 * CJK character detection
 */
function isCJK(ch: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch)
}

/**
 * Calculate optimal font size to fit text in bbox
 * Uses binary search. Handles CJK character-level line breaking.
 */
export function calculateOptimalFontSize(
  text: string,
  boxWidth: number,
  boxHeight: number,
  fontFamily: string = 'Arial',
  padding: number = 0.1
): FontMetrics {
  if (!text || boxWidth <= 0 || boxHeight <= 0) {
    return { fontSize: 12, lines: [text || ''], actualWidth: 0, actualHeight: 0 }
  }

  const availableWidth = boxWidth * (1 - 2 * padding)
  const availableHeight = boxHeight * (1 - 2 * padding)

  // Dynamic max — no arbitrary 72px cap
  const dynamicMax = Math.min(availableHeight, availableWidth, 200)
  let minSize = 6
  let maxSize = Math.max(minSize + 1, Math.floor(dynamicMax))

  let bestFit: FontMetrics | null = null

  while (maxSize - minSize > 1) {
    const fontSize = Math.floor((minSize + maxSize) / 2)
    const lines = wrapText(text, availableWidth, fontSize, fontFamily)
    const metrics = measureMultilineText(lines, fontSize, fontFamily)

    if (metrics.width <= availableWidth && metrics.height <= availableHeight) {
      bestFit = { fontSize, lines, actualWidth: metrics.width, actualHeight: metrics.height }
      minSize = fontSize
    } else {
      maxSize = fontSize
    }
  }

  if (!bestFit) {
    const lines = wrapText(text, availableWidth, minSize, fontFamily)
    const metrics = measureMultilineText(lines, minSize, fontFamily)
    bestFit = { fontSize: minSize, lines, actualWidth: metrics.width, actualHeight: metrics.height }
  }

  return bestFit
}

/**
 * Wrap text to fit within maxWidth.
 * Handles CJK text (break at any character) and Western text (break on spaces).
 */
function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string
): string[] {
  const lines: string[] = []
  let currentLine = ''

  // Tokenize: CJK chars are individual break points, spaces delimit words
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    
    if (ch === ' ') {
      // Try adding the space
      const test = currentLine + ch
      const w = measureText(test, fontSize, fontFamily).width
      if (w > maxWidth && currentLine !== '') {
        lines.push(currentLine)
        currentLine = ''
      } else {
        currentLine = test
      }
    } else if (isCJK(ch)) {
      // CJK: each character is a break opportunity
      const test = currentLine + ch
      const w = measureText(test, fontSize, fontFamily).width
      if (w > maxWidth && currentLine !== '') {
        lines.push(currentLine)
        currentLine = ch
      } else {
        currentLine = test
      }
    } else {
      // Latin character — accumulate into word
      const test = currentLine + ch
      const w = measureText(test, fontSize, fontFamily).width
      if (w > maxWidth && currentLine !== '') {
        // Try to break the current word if it's too long by itself
        lines.push(currentLine)
        currentLine = ch
      } else {
        currentLine = test
      }
    }
  }

  if (currentLine) lines.push(currentLine)
  return lines.length > 0 ? lines : [text]
}

/**
 * Measure single line of text using shared context
 */
function measureText(
  text: string,
  fontSize: number,
  fontFamily: string
): { width: number; height: number } {
  const ctx = getSharedCtx()
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
  const lineHeight = fontSize * 1.2

  for (const line of lines) {
    const metrics = measureText(line, fontSize, fontFamily)
    maxWidth = Math.max(maxWidth, metrics.width)
  }

  return { width: maxWidth, height: lines.length * lineHeight }
}
