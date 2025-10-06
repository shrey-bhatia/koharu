'use client'

import Konva from 'konva'
import { TextConfig } from 'konva/lib/shapes/Text'
import type { TextBlock as StateTextBlock } from '@/lib/state'

export interface TextBlock {
  translatedText?: string
  fontSize?: number
  textColor?: { r: number; g: number; b: number }
  manualTextColor?: { r: number; g: number; b: number }
  fontFamily?: string
  fontWeight?: string
  fontStretch?: string
  letterSpacing?: number
  lineHeight?: number
  appearance?: {
    sourceOutlineColor?: { r: number; g: number; b: number }
    outlineWidthPx?: number
  }
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/**
 * Renders text blocks using Konva.js for consistent, high-quality text rendering
 * that matches the live preview exactly.
 */
export async function renderTextWithKonva(
  canvas: HTMLCanvasElement,
  textBlocks: StateTextBlock[],
  options: {
    scale?: number
    debug?: boolean
  } = {}
): Promise<void> {
  const { scale = 1, debug = false } = options

  // Create a Konva stage that matches our canvas dimensions
  const stage = new Konva.Stage({
    container: document.createElement('div'), // Dummy container
    width: canvas.width,
    height: canvas.height,
  })

  // Create a layer for text rendering
  const layer = new Konva.Layer()
  stage.add(layer)

  // Render each text block
  for (const block of textBlocks) {
    if (!block.translatedText || !block.fontSize || !block.textColor) {
      if (debug) console.log(`[KONVA] Skipping block - missing text or styling`)
      continue
    }

    if (debug) console.log(`[KONVA] Rendering text: "${block.translatedText}"`)

    const textColor = block.manualTextColor || block.textColor
    const fontFamily = block.fontFamily || 'Arial'
    const fontWeight = block.fontWeight || 'normal'
    const fontStretch = block.fontStretch || 'normal'
    const letterSpacing = block.letterSpacing || 0
    const lineHeight = block.lineHeight || 1.2

    const boxWidth = block.xmax - block.xmin
    const boxHeight = block.ymax - block.ymin
    const maxWidth = boxWidth * 0.9 // 10% padding
    const centerX = (block.xmin + block.xmax) / 2
    const centerY = (block.ymin + block.ymax) / 2

    // Configure outline if available
    const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
    const outlineColor = hasOutline ? block.appearance.sourceOutlineColor : undefined
    const outlineWidth = hasOutline ? block.appearance.outlineWidthPx : undefined

    // Create Konva Text configuration
    const textConfig: TextConfig = {
      x: block.xmin,
      y: block.ymin,
      width: boxWidth,
      height: boxHeight,
      text: block.translatedText,
      fontSize: block.fontSize,
      fontFamily,
      fontStyle: typeof fontWeight === 'number' ? fontWeight.toString() : fontWeight,
      fontVariant: fontStretch,
      letterSpacing,
      fill: `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`,
      align: 'center',
      verticalAlign: 'middle',
      wrap: 'word',
      lineHeight,
      listening: false, // No interaction needed for export
      perfectDrawEnabled: false, // Better performance for export
    }

    // Add stroke configuration if outline is present
    if (hasOutline && outlineColor && outlineWidth) {
      textConfig.stroke = `rgb(${outlineColor.r}, ${outlineColor.g}, ${outlineColor.b})`
      textConfig.strokeWidth = outlineWidth
      textConfig.strokeScaleEnabled = false
      textConfig.strokeEnabled = true
    }

    const textNode = new Konva.Text(textConfig)
    layer.add(textNode)
  }

  // Render the Konva layer to our canvas
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')

  // Draw the Konva layer to our canvas
  layer.draw()
  const konvaCanvas = layer.getCanvas()._canvas
  ctx.drawImage(konvaCanvas, 0, 0)

  // Clean up
  stage.destroy()
}

/**
 * Utility to convert Konva text rendering to canvas for export
 */
export async function konvaTextToCanvas(
  width: number,
  height: number,
  textBlocks: StateTextBlock[],
  baseImage?: ImageBitmap
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to create canvas context')

  // Draw base image first
  if (baseImage) {
    ctx.drawImage(baseImage, 0, 0)
  }

  // Render text using Konva
  await renderTextWithKonva(canvas, textBlocks)

  return canvas
}