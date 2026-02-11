'use client'

import { useState } from 'react'
import { Play, AlertCircle, CheckCircle, X } from 'lucide-react'
import { Button, Callout, Progress } from '@radix-ui/themes'
import { invoke } from '@tauri-apps/api/core'
import { useEditorStore } from '@/lib/state'
import { imageBitmapToArrayBuffer, maskToArrayBuffer, maskToUint8Array } from '@/utils/image'
import { createImageFromBuffer } from '@/lib/image'
import { compositeMaskedRegion } from '@/utils/alpha-compositing'

interface InpaintedRegion {
  image: number[]
  mask: number[]
  x: number
  y: number
  width: number
  height: number
  maskWidth: number
  maskHeight: number
  paddedBbox: {
    xmin: number
    ymin: number
    xmax: number
    ymax: number
  }
}

export default function InpaintPanel() {
  const { image, segmentationMaskInfo, textBlocks, setInpaintedImage, renderMethod, setPipelineStage, setCurrentStage, inpaintingConfig } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentBlock, setCurrentBlock] = useState(0)
  const [cancelled, setCancelled] = useState(false)

  const runInpaint = async () => {
    if (!image || !segmentationMaskInfo || textBlocks.length === 0) {
      setError('Missing requirements. Run Detection first.')
      return
    }

    if (renderMethod === 'newlama') {
      await runNewLamaInpainting()
    } else if (renderMethod === 'lama') {
      await runLocalizedInpainting()
    } else {
      // Rectangle fill doesn't use AI inpainting
      setError('Rectangle fill is selected. Inpainting is not needed for this mode.')
      return
    }
  }

  const resolveMaskMetadata = () => {
    const maskData = maskToUint8Array(segmentationMaskInfo!.data)

    let maskWidth = segmentationMaskInfo!.width
    let maskHeight = segmentationMaskInfo!.height

    if (!maskWidth || !maskHeight || maskWidth * maskHeight !== maskData.length) {
      const perfectSquare = Math.round(Math.sqrt(maskData.length))
      if (perfectSquare * perfectSquare === maskData.length) {
        maskWidth = perfectSquare
        maskHeight = perfectSquare
      } else {
        throw new Error('Segmentation mask dimensions are inconsistent with stored data. Please rerun detection.')
      }
    }

    return { maskData, maskWidth, maskHeight }
  }

  const runLocalizedInpainting = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    setProgress(0)
    setCancelled(false)

    let cachePrimed = false

    try {
      const imageWidth = image!.bitmap.width
      const imageHeight = image!.bitmap.height

      const { maskData, maskWidth, maskHeight } = resolveMaskMetadata()

      const imagePng = await imageBitmapToArrayBuffer(image!.bitmap)
      const maskPng = await maskToArrayBuffer(maskData, maskWidth, maskHeight)

      await invoke('cache_inpainting_data', {
        imagePng: Array.from(new Uint8Array(imagePng)),
        maskPng: Array.from(new Uint8Array(maskPng)),
      })
      cachePrimed = true

      const canvas = new OffscreenCanvas(imageWidth, imageHeight)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        throw new Error('Failed to acquire inpainting compositing context')
      }
      ctx.drawImage(image!.bitmap, 0, 0)

      for (let i = 0; i < textBlocks.length; i++) {
        if (cancelled) break

        setCurrentBlock(i + 1)
        const block = textBlocks[i]

        const blockWidth = block.xmax - block.xmin
        const blockHeight = block.ymax - block.ymin
        if (blockWidth < 20 || blockHeight < 20) continue

        const result = await invoke<InpaintedRegion>('inpaint_region_cached', {
          bbox: {
            xmin: block.xmin,
            ymin: block.ymin,
            xmax: block.xmax,
            ymax: block.ymax,
          },
          config: {
            padding: inpaintingConfig.padding,
            targetSize: inpaintingConfig.targetSize,
            maskThreshold: inpaintingConfig.maskThreshold,
            maskErosion: inpaintingConfig.maskErosion,
            maskDilation: inpaintingConfig.maskDilation,
            featherRadius: inpaintingConfig.featherRadius,
            debugMode: inpaintingConfig.exportTriptychs,
          },
        })

        const expectedPixels = result.width * result.height * 4
        const pixelData = Uint8ClampedArray.from(result.image)

        console.debug('Inpaint block received', {
          index: i,
          width: result.width,
          height: result.height,
          expectedBytes: expectedPixels,
          actualBytes: pixelData.length,
          ratio: expectedPixels ? (pixelData.length / expectedPixels).toFixed(3) : 'n/a',
          firstBytes: Array.from(pixelData.slice(0, 16)),
        })

        if (pixelData.length !== expectedPixels) {
          console.warn('Unexpected inpainted crop size. Falling back to direct drawImage via blob.', {
            expected: expectedPixels,
            actual: pixelData.length,
          })
          const fallbackBlob = new Blob([new Uint8Array(result.image)])
          const fallbackBitmap = await createImageBitmap(fallbackBlob)
          ctx.drawImage(fallbackBitmap, result.x, result.y)
          fallbackBitmap.close?.()
        } else {
          const imageData = new ImageData(pixelData, result.width, result.height)
          const bitmap = await createImageBitmap(imageData)
          ctx.drawImage(bitmap, result.x, result.y)
          bitmap.close?.()
        }

        setProgress((i + 1) / textBlocks.length)
      }

      const finalBlob = await canvas.convertToBlob({ type: 'image/png' })
      const finalBuffer = await finalBlob.arrayBuffer()
      const finalImage = await createImageFromBuffer(finalBuffer)
      setInpaintedImage(finalImage)
      setPipelineStage('textless', finalImage)
      setCurrentStage('textless')
      setSuccess(true)
    } catch (err) {
      console.error('Localized LaMa invoke failed', err)
      setError(err instanceof Error ? err.message : 'Localized inpainting failed')
    } finally {
      if (cachePrimed) {
        try {
          await invoke('clear_inpainting_cache')
        } catch (cacheError) {
          console.warn('Failed to clear inpainting cache', cacheError)
        }
      }
      setLoading(false)
      setCurrentBlock(0)
      setCancelled(false)
    }
  }

  const runNewLamaInpainting = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    setProgress(0)
    setCancelled(false)

    let cachePrimed = false

    try {
      const imageWidth = image!.bitmap.width
      const imageHeight = image!.bitmap.height

      const { maskData, maskWidth, maskHeight } = resolveMaskMetadata()

      const imagePng = await imageBitmapToArrayBuffer(image!.bitmap)
      const maskPng = await maskToArrayBuffer(maskData, maskWidth, maskHeight)

      await invoke('cache_inpainting_data', {
        imagePng: Array.from(new Uint8Array(imagePng)),
        maskPng: Array.from(new Uint8Array(maskPng)),
      })
      cachePrimed = true

      const canvas = new OffscreenCanvas(imageWidth, imageHeight)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        throw new Error('Failed to acquire inpainting compositing context')
      }
      ctx.drawImage(image!.bitmap, 0, 0)

      for (let i = 0; i < textBlocks.length; i++) {
        if (cancelled) break

        setCurrentBlock(i + 1)
        const block = textBlocks[i]

        const blockWidth = block.xmax - block.xmin
        const blockHeight = block.ymax - block.ymin
        if (blockWidth < 20 || blockHeight < 20) continue

        const result = await invoke<InpaintedRegion>('inpaint_region_cached', {
          bbox: {
            xmin: block.xmin,
            ymin: block.ymin,
            xmax: block.xmax,
            ymax: block.ymax,
          },
          config: {
            padding: inpaintingConfig.padding,
            targetSize: inpaintingConfig.targetSize,
            maskThreshold: inpaintingConfig.maskThreshold,
            maskErosion: inpaintingConfig.maskErosion,
            maskDilation: inpaintingConfig.maskDilation,
            featherRadius: inpaintingConfig.featherRadius,
            debugMode: inpaintingConfig.exportTriptychs,
          },
        })

        const expectedPixels = result.width * result.height * 4
        const pixelData = Uint8ClampedArray.from(result.image)

        console.debug('NewLaMa inpaint block received', {
          index: i,
          width: result.width,
          height: result.height,
          expectedBytes: expectedPixels,
          actualBytes: pixelData.length,
          ratio: expectedPixels ? (pixelData.length / expectedPixels).toFixed(3) : 'n/a',
          firstBytes: Array.from(pixelData.slice(0, 16)),
        })

        if (pixelData.length !== expectedPixels) {
          console.warn('Unexpected inpainted crop size. Attempting blob fallback for mask composite.', {
            expected: expectedPixels,
            actual: pixelData.length,
          })

          const fallbackBlob = new Blob([new Uint8Array(result.image)])
          const fallbackBitmap = await createImageBitmap(fallbackBlob)
          const resultMask = Uint8Array.from(result.mask)

          await compositeMaskedRegion(
            ctx,
            fallbackBitmap,
            result.x,
            result.y,
            result.width,
            result.height,
            block,
            maskData,
            maskWidth,
            maskHeight,
            imageWidth,
            imageHeight,
            result.paddedBbox,
            {
              featherRadius: inpaintingConfig.featherRadius,
              autoSeamFix: inpaintingConfig.autoSeamFix,
              seamThreshold: inpaintingConfig.seamThreshold,
              precomputedMask: resultMask,
            }
          )

          fallbackBitmap.close?.()
        } else {
          const imageData = new ImageData(pixelData, result.width, result.height)
          const bitmap = await createImageBitmap(imageData)
          const resultMask = Uint8Array.from(result.mask)

          await compositeMaskedRegion(
            ctx,
            bitmap,
            result.x,
            result.y,
            result.width,
            result.height,
            block,
            maskData,
            maskWidth,
            maskHeight,
            imageWidth,
            imageHeight,
            result.paddedBbox,
            {
              featherRadius: inpaintingConfig.featherRadius,
              autoSeamFix: inpaintingConfig.autoSeamFix,
              seamThreshold: inpaintingConfig.seamThreshold,
              precomputedMask: resultMask,
            }
          )

          bitmap.close?.()
        }

        setProgress((i + 1) / textBlocks.length)
      }

      const finalBlob = await canvas.convertToBlob({ type: 'image/png' })
      const finalBuffer = await finalBlob.arrayBuffer()
      const finalImage = await createImageFromBuffer(finalBuffer)
      setInpaintedImage(finalImage)
      setPipelineStage('textless', finalImage)
      setCurrentStage('textless')
      setSuccess(true)
    } catch (err) {
      console.error('NewLaMa invoke failed', err)
      setError(err instanceof Error ? err.message : 'NewLaMa inpainting failed')
    } finally {
      if (cachePrimed) {
        try {
          await invoke('clear_inpainting_cache')
        } catch (cacheError) {
          console.warn('Failed to clear inpainting cache', cacheError)
        }
      }
      setLoading(false)
      setCurrentBlock(0)
      setCancelled(false)
    }
  }

  return (
    <div className='panel-card flex w-full flex-col'>
      {/* Header */}
      <div className='flex items-center px-4 py-3'>
        <h2 className='text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100'>Inpainting</h2>
        <div className='flex-grow'></div>
        <Button
          onClick={runInpaint}
          loading={loading}
          variant='soft'
          size='1'
          color='indigo'
          style={{ borderRadius: 8 }}
          disabled={!image || !segmentationMaskInfo || renderMethod === 'rectangle'}
        >
          <Play className='h-3.5 w-3.5' />
        </Button>
      </div>
      
      {/* Rectangle fill warning */}
      {renderMethod === 'rectangle' && (
        <div className='px-3'>
          <Callout.Root color='blue' size='1'>
            <Callout.Icon>
              <AlertCircle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>
              Rectangle fill doesn&apos;t require AI inpainting. Colors will be extracted during Render.
            </Callout.Text>
          </Callout.Root>
        </div>
      )}

      {/* Body */}
      <div className='flex flex-col gap-3 px-4 py-3 text-gray-600 dark:text-gray-300'>
        {/* Info */}
        <div className='text-xs text-gray-500 dark:text-gray-400'>
          <p>Removes Japanese text from manga using AI inpainting</p>
        </div>

        {/* Status */}
        <div className='flex flex-col gap-1.5 text-xs'>
          <div className='flex items-center justify-between'>
            <span className='text-gray-500 dark:text-gray-400'>Image</span>
            <span className={image ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}>
              {image ? '✓ Loaded' : '—'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-gray-500 dark:text-gray-400'>Segmentation mask</span>
            <span className={segmentationMaskInfo ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}>
              {segmentationMaskInfo ? `✓ Ready` : 'Run detection'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-gray-500 dark:text-gray-400'>Text regions</span>
            <span className={textBlocks.length > 0 ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}>
              {textBlocks.length > 0 ? `${textBlocks.length} detected` : 'None'}
            </span>
          </div>
        </div>

        {/* Config Info */}
        <div className='flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500'>
          <span className='rounded bg-gray-100 px-1.5 py-0.5 font-mono dark:bg-white/[.06]'>{inpaintingConfig.padding}px</span>
          <span>padding</span>
          <span className='text-gray-300 dark:text-gray-600'>·</span>
          <span className='rounded bg-gray-100 px-1.5 py-0.5 font-mono dark:bg-white/[.06]'>{inpaintingConfig.maskErosion}px</span>
          <span>erosion</span>
        </div>

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
        {success && !loading && (
          <Callout.Root color='green' size='1'>
            <Callout.Icon>
              <CheckCircle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>
              Text removed successfully! Click &quot;Inpaint&quot; tool to view result.
            </Callout.Text>
          </Callout.Root>
        )}

        {/* Progress for localized/newlama inpainting */}
        {loading && (renderMethod === 'lama' || renderMethod === 'newlama') && (
          <div className='space-y-2'>
            <div className='progress-gradient'>
              <Progress value={progress * 100} />
            </div>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              Processing block {currentBlock} of {textBlocks.length}...
            </p>
            <Button size='1' color='red' variant='soft' onClick={() => setCancelled(true)} style={{ borderRadius: 8 }}>
              <X className='h-3.5 w-3.5' />
              Cancel
            </Button>
          </div>
        )}

        {/* Loading info for full inpainting */}
        {loading && renderMethod !== 'lama' && renderMethod !== 'newlama' && (
          <div className='text-sm text-gray-600 dark:text-gray-300'>
            <p>Processing with LaMa AI model...</p>
            <p className='text-xs'>This may take 5-15 seconds depending on image size.</p>
          </div>
        )}

        {/* Instructions */}
        {!segmentationMaskInfo && (
          <Callout.Root size='1'>
            <Callout.Text>
              <strong>How it works:</strong>
              <ul className='ml-4 mt-1 list-disc text-xs'>
                <li><strong>Rectangle mode:</strong> Instant, uses full image inpainting</li>
                <li><strong>LaMa mode:</strong> Processes regions individually (basic compositing)</li>
                <li><strong>NewLaMa mode:</strong> Mask-based compositing - preserves lineart & detail</li>
                <li>Switch modes in Render panel</li>
              </ul>
            </Callout.Text>
          </Callout.Root>
        )}
      </div>
    </div>
  )
}
