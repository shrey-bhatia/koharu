'use client'

import { useState } from 'react'
import { Button, Callout, Progress, Select, Badge } from '@radix-ui/themes'
import { Play, Download, AlertCircle, CheckCircle } from 'lucide-react'
import { useEditorStore } from '@/lib/state'
import { extractBackgroundColor } from '@/utils/color-extraction'
import { ensureReadableContrast } from '@/utils/wcag-contrast'
import { calculateOptimalFontSize } from '@/utils/font-sizing'
import RenderCustomization from './render-customization'

export default function RenderPanel() {
  const { image, textBlocks, setTextBlocks, renderMethod, setRenderMethod } = useEditorStore()
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null)

  const processColors = async () => {
    if (!image) {
      setError('No image loaded')
      return
    }

    if (textBlocks.length === 0) {
      setError('No text blocks found. Run Detection first.')
      return
    }

    setProcessing(true)
    setError(null)
    setProgress(0)

    try {
      const updated = []

      for (let i = 0; i < textBlocks.length; i++) {
        const block = textBlocks[i]

        // Skip blocks without translation
        if (!block.translatedText) {
          updated.push(block)
          setProgress((i + 1) / textBlocks.length)
          continue
        }

        console.log(`Processing block ${i + 1}/${textBlocks.length}...`)

        // Extract background color from border
        const colors = await extractBackgroundColor(image.bitmap, block, 10)

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

      // 1. Draw original image
      ctx.drawImage(image.bitmap, 0, 0)

      // 2. Draw rounded rectangles
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

      // 4. Export as PNG
      const blob = await canvas.convertToBlob({ type: 'image/png', quality: 1.0 })
      const url = URL.createObjectURL(blob)

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
