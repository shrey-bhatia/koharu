📘 COMPLETE TECHNICAL SPECIFICATION: KOHARU MANGA INPAINTING
Executive Summary
This document provides exhaustive technical specifications for implementing two manga text inpainting approaches in Koharu, with emphasis on mask-driven LaMa behavior, precise coordinate systems, and seamless compositing techniques.
🔬 PART 1: UNDERSTANDING LaMa - MASK-DRIVEN INFERENCE
How LaMa Actually Works (No Hand-Waving)
Critical Insight: LaMa is NOT Prompt-Based Unlike Stable Diffusion or other generative models, LaMa has zero text input. It is purely mask-driven and context-driven:
Input:
  - Image: RGB tensor (3, H, W) normalized to [0, 1]
  - Mask: Binary tensor (1, H, W) where:
    • 1.0 (white) = pixels TO BE INPAINTED (removed/filled)
    • 0.0 (black) = pixels TO PRESERVE (keep unchanged)

Output:
  - Inpainted image: RGB tensor (3, H, W) where:
    • Masked pixels (where mask=1) are FILLED with synthesized content
    • Unmasked pixels (where mask=0) are PRESERVED from input
How LaMa "Decides" What to Fill:
Fast Fourier Convolutions (FFCs): Image-wide receptive field means LaMa "sees" the entire crop at once
Context analysis: Looks at pixels surrounding the masked region (within same crop)
Pattern inference: Detects periodic structures (screentones, gradients, solid colors)
Texture synthesis: Fills masked area with plausible continuation of surrounding patterns
Concrete Example: Speech Bubble with White Background
Input image (crop):
┌─────────────────┐
│  ┌───────────┐  │
│  │こんにちは │  │  <- Black text on white bubble
│  └───────────┘  │
└─────────────────┘

Mask (white = inpaint):
┌─────────────────┐
│  ┌───────────┐  │
│  │███████████│  │  <- Text pixels marked white
│  └───────────┘  │
└─────────────────┘

LaMa's "thought process":
1. "I see a white rectangular region with a black border (bubble outline)"
2. "The masked pixels (███) are inside this white region"
3. "Surrounding unmasked pixels are white"
4. "I should fill masked area with... white!"

Output:
┌─────────────────┐
│  ┌───────────┐  │
│  │           │  │  <- Clean white bubble interior
│  └───────────┘  │
└─────────────────┘
Why Padding/Context is Critical
Without padding (tight crop):
Input crop (exact bbox):
┌───────────┐
│こんにちは │  <- No surrounding context visible
└───────────┘

Mask:
┌───────────┐
│███████████│  <- Everything is text
└───────────┘

LaMa: "I see... mostly masked pixels and a thin border. 
       Not enough context to infer what should be here.
       I'll just fill with gray/noise."

Output:
┌───────────┐
│░░░░░░░░░░░│  <- Artifacts, wrong color
└───────────┘
With 20-30px padding:
Input crop (bbox + padding):
┌─────────────────┐
│                 │
│  こんにちは     │  <- Bubble interior visible around text
│                 │
└─────────────────┘

Mask:
┌─────────────────┐
│                 │
│  ███████████    │  <- Text masked, bubble context preserved
│                 │
└─────────────────┘

LaMa: "I see a white region with black text masked out.
       The surrounding 20px shows consistent white color.
       I'll fill with white to match the bubble interior."

Output:
┌─────────────────┐
│                 │
│                 │  <- Clean white bubble
│                 │
└─────────────────┘
Mask Requirements for Clean Results
What Makes a Good Mask:
Covers all text pixels - including anti-aliasing halos around characters
Stops at bubble outline - don't mask the bubble border itself (unless broken by text)
Includes stroke shadows - manga often has drop shadows on text
Avoids over-masking - masking non-text areas confuses LaMa
Current Koharu Mask Quality:
// From comic-text-detector/src/lib.rs

// Detection returns 1024x1024 mask where:
// - White pixels (>30 threshold) = text regions
// - Black pixels (<30) = background

// Mask is dilated then eroded to:
// - Fill gaps in text strokes (dilation)
// - Smooth edges (erosion)
const MASK_THRESHOLD: u8 = 30;

let segment = imageproc::morphology::grayscale_dilate(
    &segment,
    &imageproc::morphology::Mask::square(3),  // 3x3 kernel
);
let segment = imageproc::morphology::erode(
    &segment, 
    imageproc::distance_transform::Norm::L2, 
    1
);
This is already good - dilation ensures text is fully covered, erosion smooths edges.
🎯 OPTION 1: RECTANGLE FILL (MVP) - COMPLETE SPECIFICATION
Architecture Overview
Pipeline:
1. Detection → 1024x1024 mask + bboxes in original coords
2. For each bbox:
   a. Sample border colors (5-10px ring around bbox)
   b. Calculate median RGB → background color
   c. Check WCAG contrast with text color (from detection class)
   d. Draw filled rectangle on canvas at original resolution
   e. Auto-size translated text to fit
   f. Render text centered in bbox
3. Export composite (original res) to PNG
Phase 1A: Color Extraction - Detailed Implementation
Algorithm: Border Sampling with Median
// next/utils/color-extraction.ts

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
 * - Use median instead of mean (robust to outliers)
 * - Calculate variance to assess confidence
 */
export async function extractBackgroundColor(
  image: ImageBitmap,
  textBlock: TextBlock,
  padding: number = 10 // Border width to sample
): Promise<ColorResult> {
  
  // 1. Create temporary canvas to read pixels
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')
  
  ctx.drawImage(image, 0, 0)
  
  // 2. Define sampling region (ring around bbox)
  const innerBox = {
    xmin: Math.max(0, textBlock.xmin),
    ymin: Math.max(0, textBlock.ymin),
    xmax: Math.min(image.width, textBlock.xmax),
    ymax: Math.min(image.height, textBlock.ymax),
  }
  
  const outerBox = {
    xmin: Math.max(0, innerBox.xmin - padding),
    ymin: Math.max(0, innerBox.ymin - padding),
    xmax: Math.min(image.width, innerBox.xmax + padding),
    ymax: Math.min(image.height, innerBox.ymax + padding),
  }
  
  // 3. Sample pixels from border region
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
  
  // 4. Calculate median color (robust to outliers)
  const backgroundColor = calculateMedianColor(samples)
  
  // 5. Determine text color from detection class
  // class 0 = black text, class 1 = white text
  const textColor: RGB = textBlock.class === 0
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 }
  
  // 6. Calculate confidence based on color variance
  const variance = calculateColorVariance(samples, backgroundColor)
  const confidence = Math.exp(-variance / 1000) // Lower variance = higher confidence
  
  return {
    backgroundColor,
    textColor,
    confidence,
  }
}

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
Advanced: K-Means Clustering (Optional Enhancement)
/**
 * Use k-means to find dominant background color
 * Better for complex backgrounds with multiple colors
 */
export function extractBackgroundColorKMeans(
  samples: RGB[],
  k: number = 2 // Cluster count
): RGB {
  
  // Initialize centroids randomly
  let centroids: RGB[] = []
  for (let i = 0; i < k; i++) {
    centroids.push(samples[Math.floor(Math.random() * samples.length)])
  }
  
  // Iterate until convergence
  for (let iter = 0; iter < 10; iter++) {
    // Assign samples to nearest centroid
    const clusters: RGB[][] = Array(k).fill(null).map(() => [])
    
    for (const sample of samples) {
      let minDist = Infinity
      let bestCluster = 0
      
      for (let i = 0; i < k; i++) {
        const dist = colorDistance(sample, centroids[i])
        if (dist < minDist) {
          minDist = dist
          bestCluster = i
        }
      }
      
      clusters[bestCluster].push(sample)
    }
    
    // Update centroids
    for (let i = 0; i < k; i++) {
      if (clusters[i].length > 0) {
        centroids[i] = calculateMeanColor(clusters[i])
      }
    }
  }
  
  // Return centroid of largest cluster (dominant color)
  let largestCluster = 0
  let maxSize = 0
  
  for (let i = 0; i < k; i++) {
    const clusterSize = clusters[i].length
    if (clusterSize > maxSize) {
      maxSize = clusterSize
      largestCluster = i
    }
  }
  
  return centroids[largestCluster]
}

function colorDistance(c1: RGB, c2: RGB): number {
  const dr = c1.r - c2.r
  const dg = c1.g - c2.g
  const db = c1.b - c2.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function calculateMeanColor(samples: RGB[]): RGB {
  const sum = samples.reduce(
    (acc, s) => ({ r: acc.r + s.r, g: acc.g + s.g, b: acc.b + s.b }),
    { r: 0, g: 0, b: 0 }
  )
  return {
    r: Math.round(sum.r / samples.length),
    g: Math.round(sum.g / samples.length),
    b: Math.round(sum.b / samples.length),
  }
}
Phase 1B: WCAG Contrast Checking
// next/utils/wcag-contrast.ts

/**
 * Ensure text is readable against background
 * WCAG 2.0 Level AA requires 4.5:1 contrast for normal text
 */
export function ensureReadableContrast(
  bgColor: RGB,
  textColor: RGB,
  minContrast: number = 4.5
): { bgColor: RGB; textColor: RGB } {
  
  const currentContrast = calculateContrastRatio(bgColor, textColor)
  
  if (currentContrast >= minContrast) {
    // Already readable
    return { bgColor, textColor }
  }
  
  // Try black text
  const contrastWithBlack = calculateContrastRatio(bgColor, { r: 0, g: 0, b: 0 })
  
  // Try white text
  const contrastWithWhite = calculateContrastRatio(bgColor, { r: 255, g: 255, b: 255 })
  
  // Pick whichever gives better contrast
  const newTextColor = contrastWithBlack > contrastWithWhite
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 }
  
  return { bgColor, textColor: newTextColor }
}

/**
 * Calculate WCAG 2.0 contrast ratio
 * Formula: (L1 + 0.05) / (L2 + 0.05)
 * where L1 is lighter, L2 is darker
 */
export function calculateContrastRatio(c1: RGB, c2: RGB): number {
  const L1 = relativeLuminance(c1)
  const L2 = relativeLuminance(c2)
  
  const lighter = Math.max(L1, L2)
  const darker = Math.min(L1, L2)
  
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Calculate relative luminance (WCAG formula)
 */
export function relativeLuminance(color: RGB): number {
  // Normalize to 0-1
  const rsRGB = color.r / 255
  const gsRGB = color.g / 255
  const bsRGB = color.b / 255
  
  // Apply gamma correction
  const r = rsRGB <= 0.03928 
    ? rsRGB / 12.92 
    : Math.pow((rsRGB + 0.055) / 1.055, 2.4)
  
  const g = gsRGB <= 0.03928 
    ? gsRGB / 12.92 
    : Math.pow((gsRGB + 0.055) / 1.055, 2.4)
  
  const b = bsRGB <= 0.03928 
    ? bsRGB / 12.92 
    : Math.pow((bsRGB + 0.055) / 1.055, 2.4)
  
  // Calculate luminance
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Get contrast rating label
 */
export function getContrastRating(ratio: number): string {
  if (ratio >= 7.0) return 'AAA' // Enhanced contrast
  if (ratio >= 4.5) return 'AA'  // Minimum contrast
  if (ratio >= 3.0) return 'AA Large' // For large text only
  return 'Fail' // Does not meet WCAG standards
}
Phase 1C: Auto Font Sizing
// next/utils/font-sizing.ts

export interface FontMetrics {
  fontSize: number
  lines: string[]
  actualWidth: number
  actualHeight: number
}

/**
 * Calculate optimal font size to fit text in bbox
 * Uses binary search for efficiency
 */
export function calculateOptimalFontSize(
  text: string,
  boxWidth: number,
  boxHeight: number,
  fontFamily: string = 'Arial',
  padding: number = 0.1 // 10% padding on all sides
): FontMetrics {
  
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
      bestFit = { fontSize, lines, actualWidth: metrics.width, actualHeight: metrics.height }
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
    bestFit = { fontSize: minSize, lines, actualWidth: metrics.width, actualHeight: metrics.height }
  }
  
  return bestFit
}

/**
 * Wrap text to fit within maxWidth
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
  
  return lines
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
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  
  ctx.font = `${fontSize}px ${fontFamily}`
  const metrics = ctx.measureText(text)
  
  return {
    width: metrics.width,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
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
Phase 1D: Canvas Rendering (React Konva)
// next/components/canvas.tsx - ADD THESE LAYERS

function Canvas() {
  const { tool, scale, image, textBlocks, inpaintedImage } = useEditorStore()
  
  return (
    <Stage>
      {/* Layer 1: Original image */}
      <Layer>
        <Image image={image?.bitmap ?? null} />
      </Layer>
      
      {/* Layer 2: Rectangle fills (Option 1) */}
      {tool === 'render' && (
        <Layer>
          {textBlocks.map((block, index) => {
            if (!block.backgroundColor) return null
            
            const bg = block.manualBgColor || block.backgroundColor
            
            return (
              <Rect
                key={`fill-${index}`}
                x={block.xmin}
                y={block.ymin}
                width={block.xmax - block.xmin}
                height={block.ymax - block.ymin}
                fill={`rgb(${bg.r}, ${bg.g}, ${bg.b})`}
                cornerRadius={3} // Slight rounding for speech bubbles
              />
            )
          })}
        </Layer>
      )}
      
      {/* Layer 3: Translated text */}
      {tool === 'render' && (
        <Layer>
          {textBlocks.map((block, index) => {
            if (!block.translatedText || !block.fontSize) return null
            
            const textColor = block.manualTextColor || block.textColor
            
            return (
              <Text
                key={`text-${index}`}
                x={block.xmin}
                y={block.ymin}
                width={block.xmax - block.xmin}
                height={block.ymax - block.ymin}
                text={block.translatedText}
                fontSize={block.fontSize}
                fontFamily="Arial"
                fill={`rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`}
                align="center"
                verticalAlign="middle"
                wrap="word"
              />
            )
          })}
        </Layer>
      )}
      
      {/* Layer 4: Detection boxes (debug) */}
      {tool === 'detection' && (
        <Layer>
          {textBlocks.map((block, index) => (
            <Rect
              key={`bbox-${index}`}
              x={block.xmin}
              y={block.ymin}
              width={block.xmax - block.xmin}
              height={block.ymax - block.ymin}
              stroke="red"
              strokeWidth={2}
            />
          ))}
        </Layer>
      )}
    </Stage>
  )
}
Phase 1E: Manual Editing UI
// next/components/text-block-editor.tsx

import { useState } from 'react'
import { Button, TextArea, Slider } from '@radix-ui/themes'
import { useEditorStore, TextBlock, RGB } from '@/lib/state'

interface Props {
  blockIndex: number
}

export default function TextBlockEditor({ blockIndex }: Props) {
  const { textBlocks, setTextBlocks } = useEditorStore()
  const block = textBlocks[blockIndex]
  
  const updateBlock = (updates: Partial<TextBlock>) => {
    const updated = [...textBlocks]
    updated[blockIndex] = { ...updated[blockIndex], ...updates }
    setTextBlocks(updated)
  }
  
  return (
    <div className="p-4 border rounded space-y-4">
      <h3 className="font-bold">Edit Block #{blockIndex + 1}</h3>
      
      {/* Translation text */}
      <div>
        <label className="text-sm font-medium">Translation:</label>
        <TextArea
          value={block.translatedText || ''}
          onChange={(e) => updateBlock({ translatedText: e.target.value })}
          rows={3}
        />
      </div>
      
      {/* Background color */}
      <div>
        <label className="text-sm font-medium">Background Color:</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={rgbToHex(block.manualBgColor || block.backgroundColor)}
            onChange={(e) => updateBlock({ manualBgColor: hexToRgb(e.target.value) })}
            className="w-12 h-8 rounded cursor-pointer"
          />
          <span className="text-sm text-gray-600">
            {rgbToString(block.manualBgColor || block.backgroundColor)}
          </span>
          {block.manualBgColor && (
            <Button
              size="1"
              variant="ghost"
              onClick={() => updateBlock({ manualBgColor: undefined })}
            >
              Reset
            </Button>
          )}
        </div>
      </div>
      
      {/* Text color */}
      <div>
        <label className="text-sm font-medium">Text Color:</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={rgbToHex(block.manualTextColor || block.textColor)}
            onChange={(e) => updateBlock({ manualTextColor: hexToRgb(e.target.value) })}
            className="w-12 h-8 rounded cursor-pointer"
          />
          <span className="text-sm text-gray-600">
            Contrast: {calculateContrastRatio(
              block.manualBgColor || block.backgroundColor,
              block.manualTextColor || block.textColor
            ).toFixed(2)}:1
          </span>
        </div>
      </div>
      
      {/* Font size */}
      <div>
        <label className="text-sm font-medium">
          Font Size: {block.fontSize}px
        </label>
        <Slider
          value={[block.fontSize || 16]}
          onValueChange={([size]) => updateBlock({ fontSize: size })}
          min={8}
          max={72}
          step={1}
        />
      </div>
      
      {/* Reset all */}
      <Button
        onClick={() => updateBlock({
          manualBgColor: undefined,
          manualTextColor: undefined,
          fontSize: block.fontSize, // Keep auto-calculated size
        })}
        variant="soft"
        color="gray"
      >
        Reset to Auto
      </Button>
    </div>
  )
}

// Utility functions
function rgbToHex(color: RGB): string {
  return `#${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`
}

function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 0, g: 0, b: 0 }
}

function rgbToString(color: RGB): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}
Phase 1F: Render Panel Controller
// next/components/render-panel.tsx

import { useState } from 'react'
import { Button, Callout } from '@radix-ui/themes'
import { Play, Download, AlertCircle } from 'lucide-react'
import { useEditorStore } from '@/lib/state'
import { extractBackgroundColor, ensureReadableContrast, calculateOptimalFontSize } from '@/utils'
import TextBlockEditor from './text-block-editor'

export default function RenderPanel() {
  const { image, textBlocks, setTextBlocks } = useEditorStore()
  const [processing, setProcessing] = useState(false)
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null)
  
  const processColors = async () => {
    if (!image) return
    
    setProcessing(true)
    
    try {
      const updated = []
      
      for (const block of textBlocks) {
        // Extract background color
        const colors = await extractBackgroundColor(image.bitmap, block)
        
        // Ensure readable contrast
        const readable = ensureReadableContrast(
          colors.backgroundColor,
          colors.textColor
        )
        
        // Calculate font size
        const fontMetrics = calculateOptimalFontSize(
          block.translatedText || '',
          block.xmax - block.xmin,
          block.ymax - block.ymin
        )
        
        updated.push({
          ...block,
          backgroundColor: readable.bgColor,
          textColor: readable.textColor,
          fontSize: fontMetrics.fontSize,
        })
      }
      
      setTextBlocks(updated)
    } finally {
      setProcessing(false)
    }
  }
  
  const exportImage = async () => {
    if (!image) return
    
    // Create offscreen canvas
    const canvas = new OffscreenCanvas(image.bitmap.width, image.bitmap.height)
    const ctx = canvas.getContext('2d')!
    
    // Draw original image
    ctx.drawImage(image.bitmap, 0, 0)
    
    // Draw rectangles
    for (const block of textBlocks) {
      const bg = block.manualBgColor || block.backgroundColor
      ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`
      ctx.fillRect(block.xmin, block.ymin, block.xmax - block.xmin, block.ymax - block.ymin)
    }
    
    // Draw text
    for (const block of textBlocks) {
      const textColor = block.manualTextColor || block.textColor
      ctx.fillStyle = `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`
      ctx.font = `${block.fontSize}px Arial`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      
      const centerX = (block.xmin + block.xmax) / 2
      const centerY = (block.ymin + block.ymax) / 2
      
      ctx.fillText(block.translatedText || '', centerX, centerY)
    }
    
    // Export
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const url = URL.createObjectURL(blob)
    
    // Download
    const a = document.createElement('a')
    a.href = url
    a.download = 'translated-manga.png'
    a.click()
    
    URL.revokeObjectURL(url)
  }
  
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button onClick={processColors} loading={processing}>
          <Play className="w-4 h-4" />
          Process Colors
        </Button>
        
        <Button onClick={exportImage} disabled={!textBlocks.some(b => b.backgroundColor)}>
          <Download className="w-4 h-4" />
          Export
        </Button>
      </div>
      
      {textBlocks.length === 0 && (
        <Callout.Root>
          <Callout.Icon>
            <AlertCircle className="w-4 h-4" />
          </Callout.Icon>
          <Callout.Text>
            Run Detection and Translation first
          </Callout.Text>
        </Callout.Root>
      )}
      
      {/* Block list */}
      <div className="space-y-2">
        {textBlocks.map((block, i) => (
          <div key={i}>
            <Button
              variant={selectedBlock === i ? 'solid' : 'soft'}
              onClick={() => setSelectedBlock(selectedBlock === i ? null : i)}
              className="w-full"
            >
              Block #{i + 1}: {block.translatedText?.substring(0, 20)}...
            </Button>
            
            {selectedBlock === i && <TextBlockEditor blockIndex={i} />}
          </div>
        ))}
      </div>
    </div>
  )
}
🚀 OPTION 2: LOCALIZED LaMa INPAINTING - COMPLETE SPECIFICATION
Critical Coordinate System Understanding
The Three Coordinate Spaces:
1. ORIGINAL IMAGE SPACE
   - Dimensions: Arbitrary (e.g., 2000×3000px)
   - Bboxes are defined here
   - Example bbox: (xmin:500, ymin:800, xmax:700, ymax:900)

2. DETECTION MASK SPACE
   - Dimensions: Fixed 1024×1024px
   - Segmentation mask lives here
   - Scaling: sx = 1024/2000 = 0.512, sy = 1024/3000 = 0.341

3. LaMa INFERENCE SPACE
   - Dimensions: Configurable (default 512×512)
   - Crops are resized here for inference
   - Result is resized back to original crop size
Coordinate Mapping Example:
Original image: 2000×3000px
Text bbox: (500, 800, 700, 900) in original space

Step 1: Map to mask space (1024×1024)
  mask_xmin = 500 × (1024/2000) = 256
  mask_ymin = 800 × (1024/3000) = 273
  mask_xmax = 700 × (1024/2000) = 358
  mask_ymax = 900 × (1024/3000) = 307

Step 2: Add padding (20px in original space)
  padded_bbox_orig = (480, 780, 720, 920)
  
  padded_mask_bbox = (
    480 × 0.512 = 246,
    780 × 0.341 = 266,
    720 × 0.512 = 369,
    920 × 0.341 = 314
  )

Step 3: Crop image (original space)
  cropped_image = image[780:920, 480:720] // 240×140px

Step 4: Crop mask (mask space)
  cropped_mask = mask[266:314, 246:369] // 48×123px
  
  WAIT! Dimensions don't match!
  
  Solution: Resize cropped_mask to match cropped_image dimensions
  cropped_mask_resized = resize(cropped_mask, 240, 140)

Step 5: Run LaMa
  inpainted_crop = lama.inference(cropped_image, cropped_mask_resized)
  // Returns 240×140px inpainted crop

Step 6: Composite back at (480, 780) in original space
Backend Implementation - Rust/Tauri
// src-tauri/src/commands.rs

use serde::{Deserialize, Serialize};
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba};

#[derive(Debug, Deserialize)]
pub struct BBox {
    pub xmin: f32,
    pub ymin: f32,
    pub xmax: f32,
    pub ymax: f32,
}

#[derive(Debug, Serialize)]
pub struct InpaintedRegion {
    pub image: Vec<u8>,  // PNG bytes
    pub x: f32,          // Position in original image
    pub y: f32,
    pub width: u32,      // Dimensions of crop
    pub height: u32,
}

#[tauri::command]
pub async fn inpaint_region(
    app: AppHandle,
    image: Vec<u8>,      // Full original image (PNG)
    mask: Vec<u8>,       // Full 1024×1024 mask (PNG)
    bbox: BBox,          // Text region coordinates (original space)
    padding: Option<i32>,// Context padding (default 20px)
) -> CommandResult<InpaintedRegion> {
    
    let state = app.state::<AppState>();
    let padding = padding.unwrap_or(20);
    
    // 1. Load images
    let full_image = image::load_from_memory(&image)
        .context("Failed to load image")?;
    let full_mask_img = image::load_from_memory(&mask)
        .context("Failed to load mask")?;
    let full_mask = full_mask_img.to_luma8();
    
    let (orig_width, orig_height) = full_image.dimensions();
    
    // 2. Add padding in original space (for context)
    let padded_bbox = add_padding(&bbox, padding, orig_width, orig_height);
    
    // 3. Crop image region (original space)
    let crop_width = (padded_bbox.xmax - padded_bbox.xmin) as u32;
    let crop_height = (padded_bbox.ymax - padded_bbox.ymin) as u32;
    
    let cropped_image = full_image.crop_imm(
        padded_bbox.xmin as u32,
        padded_bbox.ymin as u32,
        crop_width,
        crop_height,
    );
    
    // 4. Crop corresponding mask region (mask space → original space)
    let cropped_mask = extract_and_resize_mask(
        &full_mask,
        &padded_bbox,
        orig_width,
        orig_height,
        crop_width,
        crop_height,
    )?;
    
    // 5. Run LaMa inference
    let inpainted_crop = state
        .lama
        .lock()
        .await
        .inference(&cropped_image, &DynamicImage::ImageLuma8(cropped_mask))
        .context("Failed to perform inpainting")?;
    
    // 6. Encode as PNG
    let mut png_bytes = Vec::new();
    inpainted_crop
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .context("Failed to encode PNG")?;
    
    Ok(InpaintedRegion {
        image: png_bytes,
        x: padded_bbox.xmin,
        y: padded_bbox.ymin,
        width: crop_width,
        height: crop_height,
    })
}

/// Add padding to bbox, clamping to image bounds
fn add_padding(
    bbox: &BBox,
    padding: i32,
    img_width: u32,
    img_height: u32,
) -> BBox {
    BBox {
        xmin: (bbox.xmin - padding as f32).max(0.0),
        ymin: (bbox.ymin - padding as f32).max(0.0),
        xmax: (bbox.xmax + padding as f32).min(img_width as f32),
        ymax: (bbox.ymax + padding as f32).min(img_height as f32),
    }
}

/// Extract mask region and resize to match crop dimensions
fn extract_and_resize_mask(
    full_mask: &image::GrayImage, // 1024×1024
    bbox: &BBox,                  // In original image coords
    orig_width: u32,
    orig_height: u32,
    target_width: u32,            // Crop dimensions
    target_height: u32,
) -> anyhow::Result<image::GrayImage> {
    
    // Calculate scale factors (original → mask)
    let scale_x = 1024.0 / orig_width as f32;
    let scale_y = 1024.0 / orig_height as f32;
    
    // Map bbox to mask coordinates
    let mask_xmin = (bbox.xmin * scale_x).floor().max(0.0) as u32;
    let mask_ymin = (bbox.ymin * scale_y).floor().max(0.0) as u32;
    let mask_xmax = (bbox.xmax * scale_x).ceil().min(1024.0) as u32;
    let mask_ymax = (bbox.ymax * scale_y).ceil().min(1024.0) as u32;
    
    let mask_crop_width = mask_xmax - mask_xmin;
    let mask_crop_height = mask_ymax - mask_ymin;
    
    // Crop mask
    let mut cropped_mask = image::GrayImage::new(mask_crop_width, mask_crop_height);
    for y in 0..mask_crop_height {
        for x in 0..mask_crop_width {
            let pixel = full_mask.get_pixel(mask_xmin + x, mask_ymin + y);
            cropped_mask.put_pixel(x, y, *pixel);
        }
    }
    
    // Resize mask to match image crop dimensions
    let resized_mask = image::imageops::resize(
        &cropped_mask,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3, // High quality for mask
    );
    
    Ok(resized_mask)
}
Feathered Alpha Compositing (Frontend)
// next/utils/alpha-compositing.ts

/**
 * Composite inpainted crop with feathered edges
 * 
 * Algorithm:
 * 1. Create alpha mask from segmentation mask
 * 2. Apply Gaussian feathering to edges
 * 3. Blend inpainted crop with original using: C = αF + (1-α)B
 */
export async function compositeWithFeathering(
  baseCtx: OffscreenCanvasRenderingContext2D,
  inpaintedCrop: ImageBitmap,
  x: number,
  y: number,
  width: number,
  height: number,
  textBlock: TextBlock,
  fullMask: number[], // 1024×1024 segmentation
  origWidth: number,
  origHeight: number,
  featherRadius: number = 5
) {
  
  // 1. Create alpha mask from segmentation
  const alphaMask = createAlphaMask(
    fullMask,
    textBlock,
    origWidth,
    origHeight,
    width,
    height,
    featherRadius
  )
  
  // 2. Create temp canvas for compositing
  const tempCanvas = new OffscreenCanvas(width, height)
  const tempCtx = tempCanvas.getContext('2d')!
  
  // 3. Draw inpainted crop
  tempCtx.drawImage(inpaintedCrop, 0, 0)
  
  // 4. Apply alpha mask (destination-in)
  tempCtx.globalCompositeOperation = 'destination-in'
  tempCtx.putImageData(alphaMask, 0, 0)
  
  // 5. Composite onto base (source-over)
  baseCtx.drawImage(tempCanvas, x, y)
}

/**
 * Create feathered alpha mask from segmentation mask
 */
function createAlphaMask(
  fullMask: number[],
  textBlock: TextBlock,
  origWidth: number,
  origHeight: number,
  cropWidth: number,
  cropHeight: number,
  featherRadius: number
): ImageData {
  
  // Map bbox to mask coordinates
  const scaleX = 1024 / origWidth
  const scaleY = 1024 / origHeight
  
  const maskXmin = Math.floor(textBlock.xmin * scaleX)
  const maskYmin = Math.floor(textBlock.ymin * scaleY)
  
  // Create alpha mask ImageData
  const alphaMask = new ImageData(cropWidth, cropHeight)
  
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      // Map crop pixel to mask coordinate
      const maskX = maskXmin + Math.floor(x / (cropWidth / (textBlock.xmax - textBlock.xmin)) * scaleX)
      const maskY = maskYmin + Math.floor(y / (cropHeight / (textBlock.ymax - textBlock.ymin)) * scaleY)
      
      const maskIdx = Math.min(maskY * 1024 + maskX, fullMask.length - 1)
      const maskValue = fullMask[maskIdx] || 0
      
      // Apply feathering
      const alpha = applyFeathering(
        maskValue,
        x,
        y,
        cropWidth,
        cropHeight,
        featherRadius
      )
      
      const idx = (y * cropWidth + x) * 4
      alphaMask.data[idx] = 255     // R
      alphaMask.data[idx + 1] = 255 // G
      alphaMask.data[idx + 2] = 255 // B
      alphaMask.data[idx + 3] = alpha // A
    }
  }
  
  return alphaMask
}

/**
 * Apply Gaussian-like feathering at edges
 */
function applyFeathering(
  maskValue: number,
  x: number,
  y: number,
  width: number,
  height: number,
  featherRadius: number
): number {
  
  // If mask value is below threshold, fully transparent
  if (maskValue < 30) return 0
  
  // Calculate distance to nearest edge
  const distToLeft = x
  const distToRight = width - x - 1
  const distToTop = y
  const distToBottom = height - y - 1
  
  const distToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom)
  
  // If far from edge, use full mask value
  if (distToEdge >= featherRadius) {
    return maskValue
  }
  
  // Apply smooth falloff (cosine easing)
  const edgeFactor = distToEdge / featherRadius
  const smoothFactor = 0.5 - 0.5 * Math.cos(edgeFactor * Math.PI)
  
  return Math.floor(maskValue * smoothFactor)
}
Poisson Blending Alternative (Advanced)
// next/utils/poisson-blending.ts

/**
 * Poisson (seamless) blending - better for textured backgrounds
 * 
 * Note: Requires external library (e.g., OpenCV.js) or manual implementation
 * This is a simplified version using gradient-domain blending
 */

import cv from '@techstark/opencv-js' // npm install @techstark/opencv-js

export async function compositeWithPoisson(
  baseImage: ImageBitmap,
  inpaintedCrop: ImageBitmap,
  x: number,
  y: number,
  mask: ImageData // Binary mask of text region
): Promise<ImageBitmap> {
  
  // Convert ImageBitmap to OpenCV Mat
  const baseMat = cv.matFromImageBitmap(baseImage)
  const cropMat = cv.matFromImageBitmap(inpaintedCrop)
  const maskMat = cv.matFromImageData(mask)
  
  // Calculate center point for blending
  const center = new cv.Point(
    x + inpaintedCrop.width / 2,
    y + inpaintedCrop.height / 2
  )
  
  // Perform seamless cloning (Poisson blending)
  const result = new cv.Mat()
  cv.seamlessClone(
    cropMat,    // Source (inpainted crop)
    baseMat,    // Destination (original image)
    maskMat,    // Mask
    center,     // Center point
    result,     // Output
    cv.NORMAL_CLONE // or MIXED_CLONE for better gradient matching
  )
  
  // Convert back to ImageBitmap
  const resultBitmap = await cv.matToImageBitmap(result)
  
  // Cleanup
  baseMat.delete()
  cropMat.delete()
  maskMat.delete()
  result.delete()
  
  return resultBitmap
}
When to Use Each Blending Method:
Scenario	Recommended Method	Reason
Solid color bubbles	Alpha feathering	Simple, fast, works well
Gradient backgrounds	Poisson (mixed clone)	Matches gradients seamlessly
Screentone patterns	Poisson (normal clone)	Preserves texture continuity
Complex manga art	Poisson (mixed clone)	Best quality, worth the complexity
Frontend Integration
// next/components/inpaint-panel.tsx - OPTION 2 VERSION

import { useState } from 'react'
import { Play, X } from 'lucide-react'
import { Button, Progress, Callout } from '@radix-ui/themes'
import { invoke } from '@tauri-apps/api/core'
import { useEditorStore } from '@/lib/state'
import { imageBitmapToArrayBuffer, maskToArrayBuffer } from '@/utils/image'
import { createImageFromBuffer } from '@/lib/image'
import { compositeWithFeathering } from '@/utils/alpha-compositing'

export default function InpaintPanel() {
  const { image, segmentationMask, textBlocks, setInpaintedImage } = useEditorStore()
  
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentBlock, setCurrentBlock] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  
  const runLocalizedInpainting = async () => {
    if (!image || !segmentationMask || textBlocks.length === 0) return
    
    setProcessing(true)
    setProgress(0)
    setCancelled(false)
    
    try {
      // Convert full image + mask to buffers (once)
      const imageBuffer = await imageBitmapToArrayBuffer(image.bitmap)
      const maskBuffer = await maskToArrayBuffer(segmentationMask)
      
      // Create canvas for compositing at original resolution
      const canvas = new OffscreenCanvas(image.bitmap.width, image.bitmap.height)
      const ctx = canvas.getContext('2d')!
      
      // Draw original image as base
      ctx.drawImage(image.bitmap, 0, 0)
      
      // Process each text block
      for (let i = 0; i < textBlocks.length; i++) {
        if (cancelled) {
          console.log('Inpainting cancelled by user')
          break
        }
        
        setCurrentBlock(i + 1)
        const block = textBlocks[i]
        
        // Skip tiny regions (use rectangle fill instead)
        const blockWidth = block.xmax - block.xmin
        const blockHeight = block.ymax - block.ymin
        if (blockWidth < 20 || blockHeight < 20) {
          console.log(`Skipping tiny block ${i + 1}`)
          continue
        }
        
        console.log(`Inpainting block ${i + 1}/${textBlocks.length}...`)
        
        // Call backend
        const result = await invoke<InpaintedRegion>('inpaint_region', {
          image: Array.from(new Uint8Array(imageBuffer)),
          mask: Array.from(new Uint8Array(maskBuffer)),
          bbox: {
            xmin: block.xmin,
            ymin: block.ymin,
            xmax: block.xmax,
            ymax: block.ymax,
          },
          padding: 25, // Context padding
        })
        
        // Convert result to ImageBitmap
        const resultBlob = new Blob([new Uint8Array(result.image)])
        const resultBitmap = await createImageBitmap(resultBlob)
        
        // Composite with feathering
        await compositeWithFeathering(
          ctx,
          resultBitmap,
          result.x,
          result.y,
          result.width,
          result.height,
          block,
          segmentationMask,
          image.bitmap.width,
          image.bitmap.height,
          7 // Feather radius
        )
        
        // Update progress
        setProgress((i + 1) / textBlocks.length)
      }
      
      // Convert final canvas to Image
      const finalBlob = await canvas.convertToBlob({ type: 'image/png' })
      const finalImage = await createImageFromBlob(finalBlob)
      setInpaintedImage(finalImage)
      
      console.log('Localized inpainting complete!')
      
    } catch (err) {
      console.error('Inpainting error:', err)
    } finally {
      setProcessing(false)
      setCurrentBlock(0)
    }
  }
  
  return (
    <div className="p-4 space-y-4 border rounded">
      <h2 className="font-bold">AI Inpainting (LaMa)</h2>
      
      {processing && (
        <div className="space-y-2">
          <Progress value={progress * 100} />
          <p className="text-sm text-gray-600">
            Processing block {currentBlock} of {textBlocks.length}...
          </p>
          <Button
            size="1"
            color="red"
            variant="soft"
            onClick={() => setCancelled(true)}
          >
            <X className="w-4 h-4" />
            Cancel
          </Button>
        </div>
      )}
      
      {!processing && (
        <Button
          onClick={runLocalizedInpainting}
          disabled={!image || !segmentationMask || textBlocks.length === 0}
        >
          <Play className="w-4 h-4" />
          Run AI Inpainting
        </Button>
      )}
      
      <Callout.Root size="1">
        <Callout.Text className="text-xs">
          <strong>How it works:</strong>
          <ul className="ml-4 list-disc">
            <li>Processes each text region individually</li>
            <li>Preserves original image resolution</li>
            <li>Takes ~5-10 seconds per text block</li>
            <li>Results are blended seamlessly</li>
          </ul>
        </Callout.Text>
      </Callout.Root>
    </div>
  )
}

interface InpaintedRegion {
  image: number[]
  x: number
  y: number
  width: number
  height: number
}
🚀 OPTION 3: NEWLAMA - LOCALIZED INPAINTING WITH MASK-BASED COMPOSITING
Executive Summary
This is the CORRECT implementation of localized LaMa inpainting with proper mask-based alpha compositing. Unlike Option 2 (which naively draws rectangles), Option 3 uses the segmentation mask to composite ONLY the text pixels, preserving surrounding detail like character lineart, screentones, and backgrounds.

Critical Differences from Option 2
Aspect	Option 2 (Current/Broken)	Option 3 (NewLaMa/Correct)
Compositing	ctx.drawImage(crop, x, y) - Replaces entire rectangular region	Alpha-blended using segmentation mask - Only replaces text pixels
Visual Result	"Scorched earth" - Rectangle overlay, same as Option 1	Seamless - Preserves lineart, gradients, screentones
GPU Usage	May fall back to iGPU (DirectML)	Explicit CUDA with user control
Layering	[Original] → [Inpainted Rectangle] → [Text]	[Original] → [Masked Inpaint] → [Text]
Quality	Low - visible rectangle boundaries	High - pixel-perfect text removal

Pipeline Architecture
Phase 1: Backend (Rust) - Per-Block Inpainting
Command: inpaint_region (already implemented, reused from Option 2)

Input:
  - Full original image (PNG bytes)
  - Full 1024×1024 segmentation mask (PNG bytes)
  - BBox coordinates (original image space)
  - Padding (default 25px for context)

Process:
  1. Add padding to bbox in original space
  2. Crop image region at original resolution
  3. Map bbox to mask coordinates (1024×1024 space)
  4. Crop and resize mask to match image crop dimensions
  5. Run LaMa inference on cropped image + mask
  6. Return PNG-encoded inpainted crop + position

Output:
  {
    image: Vec<u8>,    // PNG bytes of inpainted crop
    x: f32,            // Position in original image
    y: f32,
    width: u32,        // Crop dimensions
    height: u32
  }

Phase 2: Frontend (TypeScript) - Mask-Based Alpha Compositing
Key Innovation: Use segmentation mask as alpha channel for pixel-perfect blending

Step-by-Step Process:

1. Prepare Full-Resolution Canvas
const canvas = new OffscreenCanvas(originalWidth, originalHeight)
const ctx = canvas.getContext('2d')!
ctx.drawImage(originalImage, 0, 0)  // Base layer

2. For Each Text Block (Sequential Processing):
for (const block of textBlocks) {
  // A. Call backend for localized inpainting
  const result = await invoke('inpaint_region', {
    image: fullImageBuffer,
    mask: fullMaskBuffer,
    bbox: block,
    padding: 25
  })

  // B. Convert result to ImageBitmap
  const inpaintedCrop = await createImageBitmap(
    new Blob([new Uint8Array(result.image)])
  )

  // C. *** CRITICAL: Alpha-blended compositing ***
  await compositeMaskedRegion(
    ctx,                    // Target canvas context
    inpaintedCrop,          // LaMa-inpainted crop
    result.x,               // Position
    result.y,
    result.width,
    result.height,
    block,                  // Text block metadata
    segmentationMask,       // Full 1024×1024 mask
    originalWidth,
    originalHeight,
    featherRadius: 5        // Edge smoothing
  )
}

3. Export Final Composite
const blob = await canvas.convertToBlob({ type: 'image/png' })
const finalImage = await createImageFromBuffer(await blob.arrayBuffer())
setInpaintedImage(finalImage)

Phase 3: Alpha Compositing Algorithm
File: next/utils/alpha-compositing.ts

Core Function: compositeMaskedRegion()

export async function compositeMaskedRegion(
  baseCtx: OffscreenCanvasRenderingContext2D,
  inpaintedCrop: ImageBitmap,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  textBlock: TextBlock,
  fullMask: number[],      // 1024×1024 grayscale array
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

  // Step 2: Create alpha channel with feathering
  const alphaChannel = createFeatheredAlpha(
    maskRegion,
    cropWidth,
    cropHeight,
    featherRadius
  )

  // Step 3: Create temporary canvas for masked inpainted crop
  const tempCanvas = new OffscreenCanvas(cropWidth, cropHeight)
  const tempCtx = tempCanvas.getContext('2d')!

  // Draw inpainted crop
  tempCtx.drawImage(inpaintedCrop, 0, 0)

  // Apply alpha mask using destination-in
  const alphaImageData = new ImageData(
    new Uint8ClampedArray(alphaChannel),
    cropWidth,
    cropHeight
  )
  tempCtx.globalCompositeOperation = 'destination-in'
  tempCtx.putImageData(alphaImageData, 0, 0)

  // Step 4: Composite onto base canvas
  baseCtx.drawImage(tempCanvas, cropX, cropY)
}

Mask Extraction Logic
function extractMaskRegion(
  fullMask: number[],       // 1024×1024 flat array
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

Feathering Algorithm
function createFeatheredAlpha(
  maskRegion: Uint8Array,
  width: number,
  height: number,
  featherRadius: number
): Uint8Array {

  // RGBA format (4 bytes per pixel)
  const alpha = new Uint8Array(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskValue = maskRegion[y * width + x]

      // Skip if not text (mask value < 30)
      if (maskValue < 30) {
        const idx = (y * width + x) * 4
        alpha[idx] = 0     // R
        alpha[idx + 1] = 0 // G
        alpha[idx + 2] = 0 // B
        alpha[idx + 3] = 0 // A - fully transparent
        continue
      }

      // Calculate distance to nearest edge
      const distToLeft = x
      const distToRight = width - x - 1
      const distToTop = y
      const distToBottom = height - y - 1
      const distToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom)

      // Apply feathering
      let alphaValue = maskValue
      if (distToEdge < featherRadius) {
        // Smooth falloff using cosine easing
        const edgeFactor = distToEdge / featherRadius
        const smoothFactor = 0.5 - 0.5 * Math.cos(edgeFactor * Math.PI)
        alphaValue = Math.floor(maskValue * smoothFactor)
      }

      const idx = (y * width + x) * 4
      alpha[idx] = 255           // R (white for visibility)
      alpha[idx + 1] = 255       // G
      alpha[idx + 2] = 255       // B
      alpha[idx + 3] = alphaValue // A - actual alpha channel
    }
  }

  return alpha
}

Visual Example: Why This Works
Scenario: Anime character with speech bubble text overlay

Original Image:
┌─────────────────────────┐
│  Character lineart      │
│    ╱╲                   │
│   ╱  ╲  ┌────────┐      │
│  │ ^^ │ │こんに  │      │ <- Text overlays lineart
│   ╲__╱  │ちは    │      │
│         └────────┘      │
└─────────────────────────┘

Segmentation Mask (1024×1024):
┌─────────────────────────┐
│  ░░░░░░░░░░░░░░░░░░░░░  │ <- Black = preserve
│    ░░                   │
│   ░░░░  ┌────────┐      │
│  ░ ░░ ░ │████████│      │ <- White = text to remove
│   ░░░░  │████████│      │
│         └────────┘      │
└─────────────────────────┘

Option 2 Result (Broken):
┌─────────────────────────┐
│  Character lineart      │
│    ╱╲                   │
│   ╱  ╲  ┌────────┐      │
│  │ ^^ │ │        │      │ <- RECTANGLE destroys lineart!
│   ╲__╱  │        │      │
│         └────────┘      │
└─────────────────────────┘

Option 3 Result (Correct):
┌─────────────────────────┐
│  Character lineart      │
│    ╱╲                   │
│   ╱  ╲  ┌────────┐      │
│  │ ^^ │ │░░░░░░░░│      │ <- ONLY text removed, lineart preserved!
│   ╲__╱  │░░░░░░░░│      │    (░ = inpainted background)
│         └────────┘      │
└─────────────────────────┘

Implementation Checklist
Backend (Reuse Existing):
  ✅ inpaint_region command (already implemented)
  ✅ Coordinate mapping (already implemented)
  ✅ Mask extraction and resizing (already implemented)

Frontend (New Implementation):
  □ Create next/utils/alpha-compositing.ts
    □ compositeMaskedRegion()
    □ extractMaskRegion()
    □ createFeatheredAlpha()

  □ Update next/components/inpaint-panel.tsx
    □ Add runNewLamaInpainting() function
    □ Route based on renderMethod === 'newlama'
    □ Call compositeMaskedRegion() for each block

  □ Update next/lib/state.ts
    □ Change renderMethod type to 'rectangle' | 'lama' | 'newlama'

  □ Update next/components/render-panel.tsx
    □ Add "NewLaMa (Mask-Based)" option to dropdown
    □ Update description text

Performance Considerations
- Sequential processing: ~5-10 seconds per text block (same as Option 2)
- Mask extraction: Negligible overhead (~10ms per block)
- Feathering: Minimal overhead (~20ms per block)
- Total time: Primarily backend LaMa inference (GPU-bound)

Quality Parameters
- featherRadius: 5px (default) - Smooth transitions at edges
- maskThreshold: 30 (from detection) - Text vs background separation
- Padding: 25px (default) - Context for LaMa inference

Expected Visual Quality
✅ Seamless integration - No visible rectangle boundaries
✅ Preserved detail - Character lineart, screentones intact
✅ Clean text removal - Only text pixels replaced
✅ Smooth edges - Feathering prevents hard lines
✅ Context-aware - LaMa sees surrounding pixels for better inpainting

⚙️ PERFORMANCE & OPTIMIZATION
Batch Processing with Progress
// Option: Process multiple regions in parallel (if GPU supports it)
// Note: Most GPUs serialize inference anyway, so this mainly helps with I/O

async function batchInpaint(
  imageBuffer: ArrayBuffer,
  maskBuffer: ArrayBuffer,
  blocks: TextBlock[],
  batchSize: number = 3
): Promise<InpaintedRegion[]> {
  
  const results: InpaintedRegion[] = []
  
  for (let i = 0; i < blocks.length; i += batchSize) {
    const batch = blocks.slice(i, i + batchSize)
    
    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(block =>
        invoke<InpaintedRegion>('inpaint_region', {
          image: Array.from(new Uint8Array(imageBuffer)),
          mask: Array.from(new Uint8Array(maskBuffer)),
          bbox: block,
          padding: 25,
        })
      )
    )
    
    results.push(...batchResults)
  }
  
  return results
}
Adaptive Quality Mode
// Let user choose speed vs quality

type QualityMode = 'fast' | 'balanced' | 'quality'

const QUALITY_SETTINGS: Record<QualityMode, {
  targetSize: number,
  featherRadius: number,
  padding: number
}> = {
  fast: { targetSize: 256, featherRadius: 3, padding: 15 },
  balanced: { targetSize: 512, featherRadius: 5, padding: 20 },
  quality: { targetSize: 768, featherRadius: 7, padding: 30 },
}

// In Rust, expose target_size parameter:
// lama.inference(&image, &mask, target_size)
This comprehensive plan provides everything needed to implement both approaches with zero hand-waving. Ready to proceed with Option 1 implementation?