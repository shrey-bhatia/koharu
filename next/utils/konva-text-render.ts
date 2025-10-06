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
type RenderTargetCanvas = HTMLCanvasElement | OffscreenCanvas

export async function renderTextWithKonva(
  canvas: RenderTargetCanvas,
  textBlocks: StateTextBlock[],
  options: {
    scale?: number
    debug?: boolean
  } = {}
): Promise<void> {
  const { scale = 1, debug = false } = options

  const width = canvas.width
  const height = canvas.height

  // CRITICAL FIX: Konva requires a DOM-attached container for proper rendering
  // Create a temporary container and attach it to the document body
  const tempContainer = document.createElement('div')
  tempContainer.style.position = 'absolute'
  tempContainer.style.top = '-9999px'
  tempContainer.style.left = '-9999px'
  tempContainer.style.width = `${width}px`
  tempContainer.style.height = `${height}px`
  document.body.appendChild(tempContainer)

  // Create a Konva stage that matches our canvas dimensions
  const stage = new Konva.Stage({
    container: tempContainer, // Use DOM-attached container
    width,
    height,
  })

  // Create a layer for text rendering
  const layer = new Konva.Layer()
  stage.add(layer)

  // Render each text block
  for (const block of textBlocks) {
    if (!block.translatedText || !block.fontSize || (!block.textColor && !block.manualTextColor)) {
      if (debug) console.log(`[KONVA] Skipping block - missing text or styling`)
      continue
    }

    if (debug) console.log(`[KONVA] Rendering text: "${block.translatedText}"`)

    const textColor = block.manualTextColor || block.textColor
    const fontFamily = block.fontFamily || 'Arial'
    const boxWidth = block.xmax - block.xmin
    const boxHeight = block.ymax - block.ymin

    // Configure outline if available
    const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
    const outlineColor = hasOutline ? block.appearance.sourceOutlineColor : undefined
    const outlineWidth = hasOutline ? block.appearance.outlineWidthPx : undefined

    // CRITICAL FIX: Match EXACTLY what the live preview uses
    // Both preview and export must use identical properties for consistent rendering
    const textConfig: TextConfig = {
      x: block.xmin,
      y: block.ymin,
      width: boxWidth,
      height: boxHeight,
      text: block.translatedText,
      fontSize: block.fontSize,
      fontFamily,
      fill: `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`,
      align: 'center',
      verticalAlign: 'middle',
      wrap: 'word',
      listening: false, // No interaction needed for export
      perfectDrawEnabled: false, // Better performance for export
    }

    // Only add optional properties if they're defined
    if (block.letterSpacing !== undefined) {
      textConfig.letterSpacing = block.letterSpacing
    }
    if (block.lineHeight !== undefined) {
      textConfig.lineHeight = block.lineHeight
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
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    stage.destroy()
    document.body.removeChild(tempContainer)
    throw new Error('Failed to get canvas context')
  }

  try {
    // CRITICAL FIX: Ensure layer is fully drawn before converting
    await new Promise<void>((resolve) => {
      layer.draw()
      // Wait for next frame to ensure fonts are loaded
      requestAnimationFrame(() => resolve())
    })

    if (debug) console.log('[KONVA] Layer drawn, converting to canvas...')

    // CRITICAL FIX: toCanvas() can return HTMLCanvasElement or Promise<HTMLCanvasElement>
    // Get the rendered canvas from Konva
    const konvaCanvasResult = stage.toCanvas({ pixelRatio: scale })
    const konvaCanvas = konvaCanvasResult instanceof Promise ? await konvaCanvasResult : konvaCanvasResult

    if (debug) console.log('[KONVA] Canvas obtained, drawing to target...')

    // Draw the Konva-rendered canvas onto our target canvas
    if (canvas instanceof OffscreenCanvas) {
      // For OffscreenCanvas, use ImageBitmap
      const bitmap = await createImageBitmap(konvaCanvas)
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(bitmap, 0, 0, width, height)
      ctx.restore()
      bitmap.close()
      if (debug) console.log('[KONVA] Text rendered to OffscreenCanvas')
    } else {
      // For regular HTMLCanvasElement, draw directly
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(konvaCanvas, 0, 0, width, height)
      ctx.restore()
      if (debug) console.log('[KONVA] Text rendered to HTMLCanvasElement')
    }
  } catch (error) {
    console.error('[KONVA] Rendering error:', error)
    throw error
  } finally {
    // Clean up: destroy stage and remove temporary container
    stage.destroy()
    document.body.removeChild(tempContainer)
    if (debug) console.log('[KONVA] Cleanup complete')
  }
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