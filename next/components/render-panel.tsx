'use client'

import { useState, useEffect, useRef } from 'react'
import { Button, Callout, Progress, Select, Badge, Text } from '@radix-ui/themes'
import { Play, Download, AlertCircle, CheckCircle } from 'lucide-react'
import { useEditorStore } from '../lib/state'
import { extractBackgroundColor } from '@/utils/color-extraction'
import { ensureReadableContrast } from '@/utils/wcag-contrast'
import { calculateOptimalFontSize } from '@/utils/font-sizing'
import { calculateImprovedFontSize } from '@/utils/improved-font-sizing'
import { createImageFromBuffer, type Image } from '@/lib/image'
import { invoke } from '@tauri-apps/api/core'
import { fileSave } from 'browser-fs-access'
import RenderCustomization from './render-customization'

// Utility function for creating canvas with OffscreenCanvas fallback
function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement | OffscreenCanvas, ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx) return { canvas, ctx }
  }
  
  // Fallback to regular canvas
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get canvas context')
  return { canvas, ctx }
}

// Utility function for converting canvas to blob with fallback
async function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, options?: { type?: string, quality?: number }): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas && 'convertToBlob' in canvas) {
    return await canvas.convertToBlob(options)
  }
  
  // Fallback for HTMLCanvasElement
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Failed to convert canvas to blob'))
      }, options?.type || 'image/png', options?.quality)
    })
  }
  
  throw new Error('Unsupported canvas type')
}

interface GpuStatus {
  requested_provider: string
  active_provider: string
  device_id: number
  device_name: string | null
  success: boolean
  warmup_time_ms: number
}

export default function RenderPanel() {
  const { image, textBlocks, setTextBlocks, renderMethod, setRenderMethod, inpaintedImage, setPipelineStage, setCurrentStage, defaultFont, setTool, pipelineStages } = useEditorStore()
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus | null>(null)

  useEffect(() => {
    loadGpuStatus()
  }, [])

  // Debounced clean base regeneration when background colors change (rectangle mode only).
  // For LaMa/NewLaMa modes, the clean base is just the inpainted image and never changes,
  // so font/color tweaks in render-customization are truly instant (HtmlRenderLayer handles text).
  const regenerateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bgColorFingerprint = renderMethod === 'rectangle'
    ? textBlocks.map(b => {
        const bg = b.manualBgColor || b.backgroundColor
        return bg ? `${bg.r},${bg.g},${bg.b}` : ''
      }).join('|')
    : ''

  useEffect(() => {
    // Only regenerate if we're in final stage and have processed blocks
    const hasProcessed = textBlocks.some(b => b.backgroundColor)
    if (!hasProcessed || !pipelineStages.final) return

    if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current)
    regenerateTimerRef.current = setTimeout(() => {
      if (renderMethod === 'rectangle') {
        console.log('[REACTIVE] Background color changed, regenerating final image')
        regenerateFinalImage()
      }
    }, 300) // 300ms debounce

    return () => {
      if (regenerateTimerRef.current) clearTimeout(regenerateTimerRef.current)
    }
  }, [bgColorFingerprint]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadGpuStatus = async () => {
    try {
      const status = await invoke<GpuStatus>('get_current_gpu_status')
      setGpuStatus(status)
    } catch (err) {
      console.error('Failed to load GPU status:', err)
    }
  }

  const processColors = async () => {
    if (!image) {
      setError('No image loaded')
      return
    }

    if (textBlocks.length === 0) {
      setError('No text blocks found. Run Detection first.')
      return
    }

    // Check if we need inpainted base for LaMa/NewLaMa modes
    if ((renderMethod === 'lama' || renderMethod === 'newlama') && !inpaintedImage) {
      setError('Please run Inpainting first for LaMa/NewLaMa mode')
      return
    }

    setProcessing(true)
    setError(null)
    setProgress(0)

    try {
      const updated = []

      // PIPELINE SAFETY GUARDRAIL #1: Always extract colors from ORIGINAL image
      // Never use inpainted image for color extraction (it's already white!)
      const colorSourceImage = image.bitmap

      const totalBlocks = textBlocks.length
      const maxProgressUpdates = 20
      const progressBatchSize = Math.max(1, Math.floor(totalBlocks / maxProgressUpdates))
      const minProgressIntervalMs = 120
      const nowTime = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
      let lastProgressTime = nowTime()

      const updateProgress = (index: number) => {
        const isLast = index === totalBlocks - 1
        const isBatchBoundary = (index + 1) % progressBatchSize === 0
        const currentTime = nowTime()
        const elapsed = currentTime - lastProgressTime

        if (isLast || isBatchBoundary || elapsed >= minProgressIntervalMs) {
          setProgress((index + 1) / totalBlocks)
          lastProgressTime = currentTime
        }
      }

      // Assertion: Verify we're not accidentally using inpainted image
      if (renderMethod === 'rectangle' && inpaintedImage) {
        console.warn('[SAFETY] Rectangle mode detected with inpainted image. Using ORIGINAL for color sampling (correct).')
      }

      for (let i = 0; i < textBlocks.length; i++) {
        const block = textBlocks[i]

        // Skip blocks without translation
        if (!block.translatedText) {
          updated.push(block)
          updateProgress(i)
          continue
        }

        console.log(`Processing block ${i + 1}/${textBlocks.length}...`)

        let backgroundColor, textColor

        // Prefer appearance analysis colors if available and confident
        if (block.appearance && block.appearance.confidence > 0.5) {
          backgroundColor = block.appearance.sourceBackgroundColor
          textColor = block.appearance.sourceTextColor
          console.log(`Block ${i + 1}: Using appearance analysis (confidence: ${block.appearance.confidence.toFixed(2)})`)
        } else {
          // Fallback to ring-based extraction
          const colors = await extractBackgroundColor(colorSourceImage, block, 10)
          backgroundColor = colors.backgroundColor
          textColor = colors.textColor
          console.log(`Block ${i + 1}: Using fallback color extraction (low confidence)`)
        }

        // Apply manual overrides if set
        if (block.manualBgColor) backgroundColor = block.manualBgColor
        if (block.manualTextColor) textColor = block.manualTextColor

        // Ensure readable contrast (only when no manual override)
        if (!block.manualBgColor && !block.manualTextColor) {
          const readable = ensureReadableContrast(backgroundColor, textColor, 4.5)
          backgroundColor = readable.bgColor
          textColor = readable.textColor
        }

        // Calculate optimal font size using improved algorithm if mask stats available
        const fontToUse = block.fontFamily || defaultFont
        let fontMetrics
        if (block.maskStats) {
          fontMetrics = calculateImprovedFontSize(
            block,
            block.translatedText,
            fontToUse
          )
          console.log(`Block ${i + 1}: Using improved sizing (layout: ${fontMetrics.alignment})`)
        } else {
          // Fallback to classic algorithm
          const boxWidth = block.xmax - block.xmin
          const boxHeight = block.ymax - block.ymin
          const classic = calculateOptimalFontSize(
            block.translatedText,
            boxWidth,
            boxHeight,
            fontToUse,
            0.05  // Reduced padding from 0.1 (10%) to 0.05 (5%) for larger text
          )
          fontMetrics = {
            ...classic,
            lineHeight: 1.2,
            letterSpacing: 0,
            alignment: 'center' as const,
          }
          console.log(`Block ${i + 1}: Using fallback sizing (no mask stats)`)
        }

        console.log(`Block ${i + 1}: bg=${JSON.stringify(backgroundColor)}, fontSize=${fontMetrics.fontSize}px, lineHeight=${fontMetrics.lineHeight}, font=${fontToUse}`)

        updated.push({
          ...block,
          backgroundColor,
          textColor,
          fontSize: fontMetrics.fontSize,
          lineHeight: fontMetrics.lineHeight,
          letterSpacing: fontMetrics.letterSpacing,
          fontFamily: fontToUse,
        })

        updateProgress(i)
      }

      setProgress(1)
      
      // Generate final composited image (base + rectangles + text) — same as export.
      // This ensures preview matches export exactly.
      const finalStage = await generateFinalImage(updated)

      // Batch ALL state updates together in one synchronous block.
      // React/Zustand will render once with the complete state.
      setTextBlocks(updated)
      if (finalStage) {
        setPipelineStage('final', finalStage)
      }
      setTool('render')
      setCurrentStage('final')

      console.log('Color processing complete! Switched to render preview.')
    } catch (err) {
      console.error('Color processing error:', err)
      setError(err instanceof Error ? err.message : 'Failed to process colors')
    } finally {
      setProcessing(false)
    }
  }

  const exportImage = async () => {
    try {
      setError(null)

      if (!image) return

      console.log('[EXPORT] Generating final image (same as preview)')

      // Use the exact same function as preview — guarantees pixel-perfect match
      const finalStage = await generateFinalImage(textBlocks)
      if (!finalStage) {
        setError('Failed to generate export image')
        return
      }

      // Convert bitmap to blob
      const { canvas, ctx } = createCanvas(finalStage.bitmap.width, finalStage.bitmap.height)
      ctx.drawImage(finalStage.bitmap, 0, 0)
      const exportBlob = await canvasToBlob(canvas, { type: 'image/png', quality: 1.0 })

      await fileSave(exportBlob, {
        fileName: `translated-manga-${Date.now()}.png`,
        extensions: ['.png'],
        description: 'PNG Image',
      })

      console.log('[EXPORT] Image exported successfully!')
    } catch (err) {
      console.error('[EXPORT] Error:', err)
      setError(err instanceof Error ? err.message : 'Failed to export image')
    }
  }

  // Draw text onto a canvas using Canvas 2D API.
  // This is the SINGLE text rendering function used by both preview and export.
  // Ensures pixel-perfect consistency between what you see and what you get.
  const drawTextOnCanvas = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, blocks: typeof textBlocks) => {
    for (const block of blocks) {
      if (!block.translatedText || !block.fontSize || !block.textColor) continue

      const textColor = block.manualTextColor || block.textColor
      const fontFamily = block.fontFamily || defaultFont
      const fontWeight = block.fontWeight || 'normal'
      const fontStretch = block.fontStretch || 'normal'
      const letterSpacing = block.letterSpacing || 0
      const lineHeightMultiplier = block.lineHeight || 1.2

      ctx.font = `${fontStretch} ${fontWeight} ${block.fontSize}px ${fontFamily}`
      ctx.fillStyle = `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'

      // Outline/stroke for readability
      const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
      const outlineColor = hasOutline ? block.appearance.sourceOutlineColor : { r: 255, g: 255, b: 255 }
      const outlineWidth = hasOutline ? (block.appearance?.outlineWidthPx || 3) : 3
      ctx.strokeStyle = `rgb(${outlineColor!.r}, ${outlineColor!.g}, ${outlineColor!.b})`
      ctx.lineWidth = outlineWidth
      ctx.lineJoin = 'round'

      const boxWidth = block.xmax - block.xmin
      const boxHeight = block.ymax - block.ymin
      const centerX = block.xmin + boxWidth / 2

      // Word wrap text
      const words = block.translatedText.split(/\s+/)
      const lines: string[] = []
      let currentLine = ''

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word
        const metrics = ctx.measureText(testLine)
        if (metrics.width > boxWidth * 0.9 && currentLine) {
          lines.push(currentLine)
          currentLine = word
        } else {
          currentLine = testLine
        }
      }
      if (currentLine) lines.push(currentLine)

      // Character-level wrapping for CJK or long words
      const finalLines: string[] = []
      for (const line of lines) {
        const lineMetrics = ctx.measureText(line)
        if (lineMetrics.width > boxWidth * 0.95) {
          // Break by character
          let charLine = ''
          for (const char of line) {
            const testLine = charLine + char
            if (ctx.measureText(testLine).width > boxWidth * 0.9 && charLine) {
              finalLines.push(charLine)
              charLine = char
            } else {
              charLine = testLine
            }
          }
          if (charLine) finalLines.push(charLine)
        } else {
          finalLines.push(line)
        }
      }

      const lineHeight = block.fontSize * lineHeightMultiplier
      const totalTextHeight = finalLines.length * lineHeight
      const startY = block.ymin + (boxHeight - totalTextHeight) / 2

      // Draw each line with outline then fill
      finalLines.forEach((line, lineIndex) => {
        const lineY = startY + lineIndex * lineHeight

        // Apply letter spacing manually if needed
        if (letterSpacing !== 0) {
          let xPos = centerX - ctx.measureText(line).width / 2
          for (const char of line) {
            ctx.strokeText(char, xPos, lineY)
            ctx.fillText(char, xPos, lineY)
            xPos += ctx.measureText(char).width + letterSpacing
          }
        } else {
          ctx.strokeText(line, centerX, lineY)
          ctx.fillText(line, centerX, lineY)
        }
      })
    }
  }

  // Generate the final composited image (base + rectangles + text).
  // This is now the SINGLE rendering function for both preview and export.
  // Returns the generated Image object (does NOT set state).
  const generateFinalImage = async (blocks: typeof textBlocks): Promise<Image | null> => {
    if (!image) return null

    try {
      console.log('[FINAL_IMAGE] Generating final composited image')
      const { canvas, ctx } = createCanvas(image.bitmap.width, image.bitmap.height)

      // Determine base image based on render method
      let baseImage: ImageBitmap
      if (renderMethod === 'lama' || renderMethod === 'newlama') {
        baseImage = inpaintedImage?.bitmap || image.bitmap
        console.log(`[FINAL_IMAGE] Using ${inpaintedImage ? 'inpainted' : 'original'} image for LaMa/NewLaMa`)
      } else if (renderMethod === 'rectangle') {
        baseImage = pipelineStages.textless?.bitmap || image.bitmap
        console.log(`[FINAL_IMAGE] Using ${pipelineStages.textless ? 'textless' : 'original'} image for Rectangle Fill`)
      } else {
        baseImage = image.bitmap
        console.log('[FINAL_IMAGE] Using original image (fallback)')
      }

      // 1. Draw base image (original or textless)
      ctx.drawImage(baseImage, 0, 0)

      // 2. Draw background rectangles ONLY for Rectangle Fill mode
      if (renderMethod === 'rectangle') {
        for (const block of blocks) {
          if (!block.backgroundColor) continue

          const bg = block.manualBgColor || block.backgroundColor
          const x = block.xmin
          const y = block.ymin
          const width = block.xmax - block.xmin
          const height = block.ymax - block.ymin
          const radius = 5

          ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`
          ctx.beginPath()
          ctx.moveTo(x + radius, y)
          ctx.lineTo(x + width - radius, y)
          ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
          ctx.lineTo(x + width, y + height - radius)
          ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
          ctx.lineTo(x + radius, y + height)
          ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
          ctx.lineTo(x, y + radius)
          ctx.quadraticCurveTo(x, y, x + radius, y)
          ctx.closePath()
          ctx.fill()
        }
      }

      // 3. Draw text using the shared Canvas 2D function
      drawTextOnCanvas(ctx, blocks)

      const finalBlob = await canvasToBlob(canvas, { type: 'image/png', quality: 1.0 })
      const finalBuffer = await finalBlob.arrayBuffer()
      const finalStage = await createImageFromBuffer(finalBuffer)

      console.log('[FINAL_IMAGE] Final composited image generated successfully')
      return finalStage
    } catch (err) {
      console.error('Failed to generate final image:', err)
      return null
    }
  }
  
  // Wrapper for reactive updates — regenerates final image when colors change
  const regenerateFinalImage = async () => {
    const finalStage = await generateFinalImage(textBlocks)
    if (finalStage) {
      setPipelineStage('final', finalStage)
    }
    return finalStage
  }

  const hasProcessedColors = textBlocks.some(b => b.backgroundColor)
  const hasTranslations = textBlocks.some(b => b.translatedText)

  return (
    <div className='panel-card flex w-full flex-col'>
      {/* Header */}
      <div className='flex items-center gap-2 px-4 py-3'>
        <h2 className='text-sm font-semibold tracking-tight text-gray-800 dark:text-white'>Render</h2>
        <div className='flex-grow'></div>
        <Button
          onClick={processColors}
          loading={processing}
          variant='soft'
          size='1'
          color='indigo'
          style={{ borderRadius: 8 }}
          disabled={!image || !hasTranslations}
        >
          <Play className='h-3.5 w-3.5' />
          Process
        </Button>
        <Button
          onClick={exportImage}
          variant='solid'
          size='1'
          color='indigo'
          style={{ borderRadius: 8 }}
          disabled={!hasProcessedColors}
        >
          <Download className='h-3.5 w-3.5' />
          Export
        </Button>
      </div>

      {/* GPU Status */}
      {gpuStatus && (
        <div className='border-t border-gray-100 px-4 py-3 dark:border-white/[.04]'>
          <label className='text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500'>
            GPU Status
          </label>
          <div className='mt-1 flex items-center gap-2'>
            <Badge
              color={gpuStatus.success && !gpuStatus.active_provider.includes('fallback') ? 'green' : 'red'}
              size='2'
            >
              {gpuStatus.success ? '✓' : '✗'} {gpuStatus.active_provider}
              {gpuStatus.device_name && ` (${gpuStatus.device_name})`}
            </Badge>
            {gpuStatus.warmup_time_ms > 0 && (
              <Text size='1' color='gray'>{gpuStatus.warmup_time_ms}ms</Text>
            )}
          </div>
          {gpuStatus.active_provider.includes('fallback') && (
            <Callout.Root color='yellow' size='1' className='mt-2'>
              <Callout.Text>Warning: GPU may have fallen back to CPU. Check Settings.</Callout.Text>
            </Callout.Root>
          )}
        </div>
      )}

      {/* Method Toggle */}
      <div className='border-t border-gray-100 px-4 py-3 dark:border-white/[.04]'>
        <label className='text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500'>
          Rendering Method
        </label>
        <Select.Root value={renderMethod} onValueChange={(value: 'rectangle' | 'lama' | 'newlama') => setRenderMethod(value)}>
          <Select.Trigger className='w-full' />
          <Select.Content>
            <Select.Item value='rectangle'>
              <div className='flex flex-col'>
                <span className='font-medium'>Rectangle Fill (Fast)</span>
                <span className='text-xs text-gray-500'>Instant, works on all devices</span>
              </div>
            </Select.Item>
            <Select.Item value='lama'>
              <div className='flex flex-col'>
                <span className='font-medium'>LaMa AI (Basic)</span>
                <span className='text-xs text-gray-500'>Per-region inpainting, basic compositing</span>
              </div>
            </Select.Item>
            <Select.Item value='newlama'>
              <div className='flex flex-col'>
                <span className='font-medium'>NewLaMa (Best Quality)</span>
                <span className='text-xs text-gray-500'>Mask-based compositing, preserves lineart & detail</span>
              </div>
            </Select.Item>
          </Select.Content>
        </Select.Root>
      </div>

      {/* Body */}
      <div className='flex flex-col gap-3 px-4 py-3'>
        {/* Progress */}
        {processing && (
          <div className='space-y-2'>
            <div className='progress-gradient'>
              <Progress value={progress * 100} />
            </div>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              Processing colors and fonts… {Math.round(progress * 100)}%
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <Callout.Root color='red' size='1'>
            <Callout.Icon>
              <AlertCircle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        {/* Success */}
        {hasProcessedColors && !processing && (
          <Callout.Root color='green' size='1'>
            <Callout.Icon>
              <CheckCircle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>
              Ready to export! Customize blocks below or export now.
            </Callout.Text>
          </Callout.Root>
        )}

        {/* Status */}
        <div className='flex flex-col gap-1.5 text-xs'>
          <div className='flex items-center justify-between'>
            <span className='text-gray-500 dark:text-gray-400'>Image</span>
            <span className={image ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
              {image ? '✓ Loaded' : '—'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-gray-500 dark:text-gray-400'>Text blocks</span>
            <span className={textBlocks.length > 0 ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
              {textBlocks.length > 0 ? `${textBlocks.length} detected` : '—'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-gray-500 dark:text-gray-400'>Translations</span>
            <span className={hasTranslations ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}>
              {hasTranslations ? `${textBlocks.filter(b => b.translatedText).length} ready` : '—'}
            </span>
          </div>
        </div>

        {/* Block List for Customization */}
        {hasProcessedColors && (
          <div className='mt-2 space-y-2'>
            <h3 className='text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500'>Customize Blocks</h3>
            <div className='max-h-64 space-y-1 overflow-y-auto'>
              {textBlocks.map((block, i) => (
                block.backgroundColor && (
                  <div key={i}>
                    <button
                      onClick={() => setSelectedBlock(selectedBlock === i ? null : i)}
                      className='flex w-full items-center justify-between rounded-lg p-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-white/[.03]'
                    >
                      <div className='flex items-center gap-2'>
                        <Badge>{i + 1}</Badge>
                        <span className='dark:text-gray-200'>{block.translatedText?.substring(0, 30)}...</span>
                      </div>
                      <span className='text-xs text-gray-500 dark:text-gray-400'>
                        {selectedBlock === i ? '▼' : '▶'}
                      </span>
                    </button>
                    {selectedBlock === i && (
                      <RenderCustomization blockIndex={i} />
                    )}
                  </div>
                )
              ))}
            </div>
          </div>
        )}

        {/* Instructions */}
        {!hasTranslations && (
          <Callout.Root size='1'>
            <Callout.Text>
              <strong>To render translations:</strong>
            </Callout.Text>
            <div className='ml-4 mt-1 text-xs'>
              <ol className='list-decimal'>
                <li>Run Detection to find text</li>
                <li>Run OCR to extract Japanese</li>
                <li>Run Translation to get English</li>
                <li>Click &quot;Process&quot; to calculate colors/fonts</li>
                <li>Customize individual blocks if needed</li>
                <li>Click &quot;Export&quot; to save final image</li>
              </ol>
            </div>
          </Callout.Root>
        )}
      </div>
    </div>
  )
}
