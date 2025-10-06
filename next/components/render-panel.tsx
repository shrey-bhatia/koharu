'use client'

import { useState, useEffect } from 'react'
import { Button, Callout, Progress, Select, Badge, Text } from '@radix-ui/themes'
import { Play, Download, AlertCircle, CheckCircle } from 'lucide-react'
import { useEditorStore } from '@/lib/state'
import { extractBackgroundColor } from '@/utils/color-extraction'
import { ensureReadableContrast } from '@/utils/wcag-contrast'
import { calculateOptimalFontSize } from '@/utils/font-sizing'
import { calculateImprovedFontSize } from '@/utils/improved-font-sizing'
import { createImageFromBuffer } from '@/lib/image'
import { invoke } from '@tauri-apps/api/core'
import RenderCustomization from './render-customization'
import { renderTextWithKonva } from '@/utils/konva-text-render'

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
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    loadGpuStatus()
  }, [])

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

      // Assertion: Verify we're not accidentally using inpainted image
      if (renderMethod === 'rectangle' && inpaintedImage) {
        console.warn('[SAFETY] Rectangle mode detected with inpainted image. Using ORIGINAL for color sampling (correct).')
      }

      for (let i = 0; i < textBlocks.length; i++) {
        const block = textBlocks[i]

        // Skip blocks without translation
        if (!block.translatedText) {
          updated.push(block)
          setProgress((i + 1) / textBlocks.length)
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
            0.1
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

        setProgress((i + 1) / textBlocks.length)
      }

      setTextBlocks(updated)

      // Generate final composition and save as pipeline stage
      await generateFinalComposition()

      // Switch to render tool and 'final' stage to show live preview with rendered text
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
      setExporting(true)
      setError(null)

      // Check if we already have a final composition
      const existingFinalStage = pipelineStages.final
      if (existingFinalStage) {
        console.log('[EXPORT] Using existing final stage for export')
        // Use existing final stage for export
        const blob = new Blob([existingFinalStage.buffer], { type: 'image/png' })
        const url = URL.createObjectURL(blob)
        
        // Trigger download
        const a = document.createElement('a')
        a.href = url
        a.download = `translated-manga-${Date.now()}.png`
        a.click()

        URL.revokeObjectURL(url)
        console.log('Image exported successfully (using existing final composition)!')
        return
      }

      console.log('[EXPORT] No existing final stage, creating new one')
      // If no existing final stage, create one (original export logic)
      if (!image) return

      try {
        // Create canvas at original resolution using utility function
        const { canvas, ctx } = createCanvas(image.bitmap.width, image.bitmap.height)

        // Determine base image based on render method
        let baseImage: ImageBitmap
        if (renderMethod === 'lama' || renderMethod === 'newlama') {
          // LaMa/NewLaMa methods use inpainted image
          baseImage = inpaintedImage?.bitmap || image.bitmap
        } else if (renderMethod === 'rectangle') {
          // Rectangle Fill method uses textless image if available, otherwise original
          baseImage = pipelineStages.textless?.bitmap || image.bitmap
        } else {
          // Fallback to original image
          baseImage = image.bitmap
        }

        // 1. Draw base image (original or textless)
        console.log('[EXPORT] Drawing base image')
        ctx.drawImage(baseImage, 0, 0)

        // PIPELINE SAFETY GUARDRAIL #2: Draw rectangles ONLY for Rectangle Fill mode
        // LaMa/NewLaMa modes render text directly over textless plate
        if (renderMethod === 'rectangle') {
          console.log('[PIPELINE] Drawing rectangles for Rectangle Fill mode')
          for (const block of textBlocks) {
            if (!block.backgroundColor) continue

            const bg = block.manualBgColor || block.backgroundColor
            const x = block.xmin
            const y = block.ymin
            const width = block.xmax - block.xmin
            const height = block.ymax - block.ymin
            const radius = 5

            ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`
            ctx.beginPath()
            ctx.roundRect(x, y, width, height, radius)
            ctx.fill()
          }
        } else {
          console.log('[PIPELINE] Skipping rectangles for LaMa/NewLaMa mode (using textless plate)')
        }

        // Save 'withRectangles' stage (base + backgrounds, no text yet)
        const rectanglesBlob = await canvasToBlob(canvas, { type: 'image/png' })
        const rectanglesBuffer = await rectanglesBlob.arrayBuffer()
        const rectanglesStage = await createImageFromBuffer(rectanglesBuffer)
        setPipelineStage('withRectangles', rectanglesStage)

        // 3. Draw translated text using Konva for consistent, high-quality rendering
        console.log(`[EXPORT] Drawing text for ${textBlocks.length} blocks using Konva`)

        // Use Konva for text rendering (replaces problematic Canvas 2D text rendering)
        await renderTextWithKonva(canvas, textBlocks, { debug: true })

        // 4. Save final stage and export as PNG
        const finalBlob = await canvasToBlob(canvas, { type: 'image/png', quality: 1.0 })
        const finalBuffer = await finalBlob.arrayBuffer()
        const finalStage = await createImageFromBuffer(finalBuffer)
        setPipelineStage('final', finalStage)
        setCurrentStage('final')

        const url = URL.createObjectURL(finalBlob)

        // 5. Trigger download
        const a = document.createElement('a')
        a.href = url
        a.download = `translated-manga-${Date.now()}.png`
        a.click()

        URL.revokeObjectURL(url)

        console.log('Image exported successfully!')
      } catch (err) {
        console.error('Export error:', err)
        setError(err instanceof Error ? err.message : 'Failed to export image')
      } finally {
        setExporting(false)
      }
    } catch (err) {
      console.error('Export error:', err)
      setError(err instanceof Error ? err.message : 'Failed to export image')
    }
  }

  // Generate final composition and save as pipeline stage
  const generateFinalComposition = async () => {
    if (!image) return null

    try {
      console.log('[FINAL_COMP] Generating final composition')
      // Create offscreen canvas at original resolution
      const { canvas, ctx } = createCanvas(image.bitmap.width, image.bitmap.height)

      // Determine base image based on render method
      let baseImage: ImageBitmap
      if (renderMethod === 'lama' || renderMethod === 'newlama') {
        // LaMa/NewLaMa methods use inpainted image
        baseImage = inpaintedImage?.bitmap || image.bitmap
        console.log(`[FINAL_COMP] Using ${inpaintedImage ? 'inpainted' : 'original'} image for LaMa/NewLaMa`)
      } else if (renderMethod === 'rectangle') {
        // Rectangle Fill method uses textless image if available, otherwise original
        baseImage = pipelineStages.textless?.bitmap || image.bitmap
        console.log(`[FINAL_COMP] Using ${pipelineStages.textless ? 'textless' : 'original'} image for Rectangle Fill`)
      } else {
        // Fallback to original image
        baseImage = image.bitmap
        console.log('[FINAL_COMP] Using original image (fallback)')
      }

      // 1. Draw base image (original or textless)
      ctx.drawImage(baseImage, 0, 0)

      // 2. Draw rectangles ONLY for Rectangle Fill mode
      if (renderMethod === 'rectangle') {
        for (const block of textBlocks) {
          if (!block.backgroundColor) continue

          const bg = block.manualBgColor || block.backgroundColor
          const x = block.xmin
          const y = block.ymin
          const width = block.xmax - block.xmin
          const height = block.ymax - block.ymin
          const radius = 5

          ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`
          ctx.beginPath()
          ctx.roundRect(x, y, width, height, radius)
          ctx.fill()
        }
      }

        // 3. Draw translated text using Konva for consistent, high-quality rendering
        console.log(`[FINAL_COMP] Drawing text for ${textBlocks.length} blocks using Konva`)

        // Use Konva for text rendering (replaces problematic Canvas 2D text rendering)
        await renderTextWithKonva(canvas, textBlocks, { debug: true })

      // Save final stage
      const finalBlob = await canvasToBlob(canvas, { type: 'image/png', quality: 1.0 })
      const finalBuffer = await finalBlob.arrayBuffer()
      const finalStage = await createImageFromBuffer(finalBuffer)
      setPipelineStage('final', finalStage)

      return finalStage
    } catch (err) {
      console.error('Failed to generate final composition:', err)
      return null
    }
  }

  const hasProcessedColors = textBlocks.some(b => b.backgroundColor)
  const hasTranslations = textBlocks.some(b => b.translatedText)

  return (
    <div className='flex w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md dark:border-gray-700 dark:bg-gray-800'>
      {/* Header */}
      <div className='flex items-center gap-2 p-3'>
        <h2 className='font-medium dark:text-white'>Render</h2>
        <div className='flex-grow'></div>
        <Button
          onClick={processColors}
          loading={processing}
          variant='soft'
          disabled={!image || !hasTranslations}
        >
          <Play className='h-4 w-4' />
          Process
        </Button>
        <Button
          onClick={exportImage}
          variant='solid'
          disabled={!hasProcessedColors}
        >
          <Download className='h-4 w-4' />
          Export
        </Button>
      </div>

      {/* GPU Status */}
      {gpuStatus && (
        <div className='border-t border-gray-200 p-3 dark:border-gray-700'>
          <label className='text-xs font-semibold text-gray-600 dark:text-gray-400'>
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
      <div className='border-t border-gray-200 p-3 dark:border-gray-700'>
        <label className='text-xs font-semibold text-gray-600 dark:text-gray-400'>
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
      <div className='flex flex-col gap-2 p-3'>
        {/* Progress */}
        {processing && (
          <div className='space-y-2'>
            <Progress value={progress * 100} />
            <p className='text-sm text-gray-600 dark:text-gray-400'>
              Processing colors and fonts... {Math.round(progress * 100)}%
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
        <div className='flex flex-col gap-1 text-sm'>
          <div className='flex items-center justify-between'>
            <span className='dark:text-gray-300'>Image:</span>
            <span className={image ? 'text-green-600' : 'text-gray-400'}>
              {image ? '✓ Loaded' : 'Not loaded'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='dark:text-gray-300'>Text blocks:</span>
            <span className={textBlocks.length > 0 ? 'text-green-600' : 'text-gray-400'}>
              {textBlocks.length > 0 ? `${textBlocks.length} detected` : 'None'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='dark:text-gray-300'>Translations:</span>
            <span className={hasTranslations ? 'text-green-600' : 'text-gray-400'}>
              {hasTranslations ? `${textBlocks.filter(b => b.translatedText).length} ready` : 'None'}
            </span>
          </div>
        </div>

        {/* Block List for Customization */}
        {hasProcessedColors && (
          <div className='mt-2 space-y-2'>
            <h3 className='text-sm font-semibold dark:text-white'>Customize Blocks</h3>
            <div className='max-h-64 space-y-1 overflow-y-auto'>
              {textBlocks.map((block, i) => (
                block.backgroundColor && (
                  <div key={i}>
                    <button
                      onClick={() => setSelectedBlock(selectedBlock === i ? null : i)}
                      className='flex w-full items-center justify-between rounded p-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700'
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
                      <RenderCustomization blockIndex={i} onReProcess={processColors} />
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
              <ol className='ml-4 mt-1 list-decimal text-xs'>
                <li>Run Detection to find text</li>
                <li>Run OCR to extract Japanese</li>
                <li>Run Translation to get English</li>
                <li>Click "Process" to calculate colors/fonts</li>
                <li>Customize individual blocks if needed</li>
                <li>Click "Export" to save final image</li>
              </ol>
            </Callout.Text>
          </Callout.Root>
        )}
      </div>
    </div>
  )
}
