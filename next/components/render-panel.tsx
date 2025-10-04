'use client'

import { useState, useEffect } from 'react'
import { Button, Callout, Progress, Select, Badge, Text } from '@radix-ui/themes'
import { Play, Download, AlertCircle, CheckCircle } from 'lucide-react'
import { useEditorStore } from '@/lib/state'
import { extractBackgroundColor } from '@/utils/color-extraction'
import { ensureReadableContrast } from '@/utils/wcag-contrast'
import { calculateOptimalFontSize } from '@/utils/font-sizing'
import { createImageFromBuffer } from '@/lib/image'
import { invoke } from '@tauri-apps/api/core'
import RenderCustomization from './render-customization'

interface GpuStatus {
  requested_provider: string
  active_provider: string
  device_id: number
  device_name: string | null
  success: boolean
  warmup_time_ms: number
}

export default function RenderPanel() {
  const { image, textBlocks, setTextBlocks, renderMethod, setRenderMethod, inpaintedImage, setPipelineStage, setCurrentStage } = useEditorStore()
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus | null>(null)

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

      // CRITICAL FIX: Always extract colors from ORIGINAL image
      // Never use inpainted image for color extraction (it's already white!)
      const colorSourceImage = image.bitmap

      for (let i = 0; i < textBlocks.length; i++) {
        const block = textBlocks[i]

        // Skip blocks without translation
        if (!block.translatedText) {
          updated.push(block)
          setProgress((i + 1) / textBlocks.length)
          continue
        }

        console.log(`Processing block ${i + 1}/${textBlocks.length}...`)

        // Extract background color from ORIGINAL image border
        const colors = await extractBackgroundColor(colorSourceImage, block, 10)

        // Ensure readable contrast
        const readable = ensureReadableContrast(
          colors.backgroundColor,
          colors.textColor,
          4.5
        )

        // Calculate optimal font size
        const boxWidth = block.xmax - block.xmin
        const boxHeight = block.ymax - block.ymin
        const fontMetrics = calculateOptimalFontSize(
          block.translatedText,
          boxWidth,
          boxHeight,
          block.fontFamily || 'Arial',
          0.1
        )

        console.log(`Block ${i + 1}: bg=${JSON.stringify(readable.bgColor)}, fontSize=${fontMetrics.fontSize}px`)

        updated.push({
          ...block,
          backgroundColor: readable.bgColor,
          textColor: readable.textColor,
          fontSize: fontMetrics.fontSize,
          fontFamily: block.fontFamily || 'Arial',
        })

        setProgress((i + 1) / textBlocks.length)
      }

      setTextBlocks(updated)
      console.log('Color processing complete!')
    } catch (err) {
      console.error('Color processing error:', err)
      setError(err instanceof Error ? err.message : 'Failed to process colors')
    } finally {
      setProcessing(false)
    }
  }

  const exportImage = async () => {
    if (!image) return

    try {
      // Create offscreen canvas at original resolution
      const canvas = new OffscreenCanvas(image.bitmap.width, image.bitmap.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Failed to get canvas context')

      // Determine base image based on render method
      const baseImage = (renderMethod === 'lama' || renderMethod === 'newlama') && inpaintedImage
        ? inpaintedImage.bitmap
        : image.bitmap

      // 1. Draw base image (original or textless)
      ctx.drawImage(baseImage, 0, 0)

      // 2. Draw rounded rectangles (ONLY for Rectangle Fill mode)
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

      // Save 'withRectangles' stage (base + backgrounds, no text yet)
      const rectanglesBlob = await canvas.convertToBlob({ type: 'image/png' })
      const rectanglesBuffer = await rectanglesBlob.arrayBuffer()
      const rectanglesStage = await createImageFromBuffer(rectanglesBuffer)
      setPipelineStage('withRectangles', rectanglesStage)

      // 3. Draw translated text with advanced typography support and proper wrapping
      for (const block of textBlocks) {
        if (!block.translatedText || !block.fontSize || !block.textColor) continue

        const textColor = block.manualTextColor || block.textColor
        const fontFamily = block.fontFamily || 'Arial'
        const fontWeight = block.fontWeight || 'normal'
        const fontStretch = block.fontStretch || 'normal'
        const letterSpacing = block.letterSpacing || 0

        ctx.fillStyle = `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`
        ctx.font = `${fontStretch} ${fontWeight} ${block.fontSize}px ${fontFamily}`
        ctx.letterSpacing = `${letterSpacing}px`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'

        const boxWidth = block.xmax - block.xmin
        const boxHeight = block.ymax - block.ymin
        const maxWidth = boxWidth * 0.9 // 10% padding
        const centerX = (block.xmin + block.xmax) / 2
        const centerY = (block.ymin + block.ymax) / 2

        // Wrap text to fit within box width
        const words = block.translatedText.split(' ')
        const lines: string[] = []
        let currentLine = ''

        for (const word of words) {
          const testLine = currentLine + (currentLine ? ' ' : '') + word
          const metrics = ctx.measureText(testLine)

          if (metrics.width > maxWidth && currentLine !== '') {
            lines.push(currentLine)
            currentLine = word
          } else {
            currentLine = testLine
          }
        }
        if (currentLine) lines.push(currentLine)

        const lineHeight = block.fontSize * 1.2
        const totalHeight = lines.length * lineHeight

        // Start from top if text is too tall, otherwise center vertically
        const startY = totalHeight > boxHeight * 0.9
          ? block.ymin + lineHeight / 2
          : centerY - ((lines.length - 1) * lineHeight) / 2

        lines.forEach((line, i) => {
          ctx.fillText(line, centerX, startY + i * lineHeight, maxWidth)
        })
      }

      // 4. Save final stage and export as PNG
      const finalBlob = await canvas.convertToBlob({ type: 'image/png', quality: 1.0 })
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
