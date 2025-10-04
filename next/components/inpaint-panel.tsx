'use client'

import { useState } from 'react'
import { Play, AlertCircle, CheckCircle, X } from 'lucide-react'
import { Button, Text, Callout, Progress } from '@radix-ui/themes'
import { invoke } from '@tauri-apps/api/core'
import { useEditorStore } from '@/lib/state'
import { imageBitmapToArrayBuffer, maskToArrayBuffer } from '@/utils/image'
import { createImageFromBuffer } from '@/lib/image'
import { compositeMaskedRegion } from '@/utils/alpha-compositing'

interface InpaintedRegion {
  image: number[]
  x: number
  y: number
  width: number
  height: number
}

export default function InpaintPanel() {
  const { image, segmentationMask, textBlocks, setInpaintedImage, renderMethod, setPipelineStage, setCurrentStage } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentBlock, setCurrentBlock] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  const [debugMode, setDebugMode] = useState(false)

  const runInpaint = async () => {
    if (!image || !segmentationMask || textBlocks.length === 0) {
      setError('Missing requirements. Run Detection first.')
      return
    }

    if (renderMethod === 'newlama') {
      await runNewLamaInpainting()
    } else if (renderMethod === 'lama') {
      await runLocalizedInpainting()
    } else {
      await runFullInpainting()
    }
  }

  const runFullInpainting = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const imageBuffer = await imageBitmapToArrayBuffer(image!.bitmap)
      const maskBuffer = await maskToArrayBuffer(segmentationMask!)

      const result = await invoke<number[]>('inpaint', {
        image: Array.from(new Uint8Array(imageBuffer)),
        mask: Array.from(new Uint8Array(maskBuffer)),
      })

      const resultBuffer = new Uint8Array(result).buffer
      const inpainted = await createImageFromBuffer(resultBuffer)
      setInpaintedImage(inpainted)
      setPipelineStage('textless', inpainted)
      setCurrentStage('textless')
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inpainting failed')
    } finally {
      setLoading(false)
    }
  }

  const runLocalizedInpainting = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    setProgress(0)
    setCancelled(false)

    try {
      const imageBuffer = await imageBitmapToArrayBuffer(image!.bitmap)
      const maskBuffer = await maskToArrayBuffer(segmentationMask!)

      // Create canvas at original resolution
      const canvas = new OffscreenCanvas(image!.bitmap.width, image!.bitmap.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image!.bitmap, 0, 0)

      // Process each text block
      for (let i = 0; i < textBlocks.length; i++) {
        if (cancelled) break

        setCurrentBlock(i + 1)
        const block = textBlocks[i]

        const blockWidth = block.xmax - block.xmin
        const blockHeight = block.ymax - block.ymin
        if (blockWidth < 20 || blockHeight < 20) continue

        const result = await invoke<InpaintedRegion>('inpaint_region', {
          image: Array.from(new Uint8Array(imageBuffer)),
          mask: Array.from(new Uint8Array(maskBuffer)),
          bbox: {
            xmin: block.xmin,
            ymin: block.ymin,
            xmax: block.xmax,
            ymax: block.ymax,
          },
          padding: 40,  // Option 2: Increased padding for better context
          debugMode,     // Enable debug triptych exports
        })

        const blob = new Blob([new Uint8Array(result.image)])
        const bitmap = await createImageBitmap(blob)

        // Simple composite (feathering implemented later)
        ctx.drawImage(bitmap, result.x, result.y)

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
      setError(err instanceof Error ? err.message : 'Localized inpainting failed')
    } finally {
      setLoading(false)
      setCurrentBlock(0)
    }
  }

  const runNewLamaInpainting = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    setProgress(0)
    setCancelled(false)

    try {
      const imageBuffer = await imageBitmapToArrayBuffer(image!.bitmap)
      const maskBuffer = await maskToArrayBuffer(segmentationMask!)

      // Create canvas at original resolution
      const canvas = new OffscreenCanvas(image!.bitmap.width, image!.bitmap.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image!.bitmap, 0, 0)

      // Process each text block with mask-based compositing
      for (let i = 0; i < textBlocks.length; i++) {
        if (cancelled) break

        setCurrentBlock(i + 1)
        const block = textBlocks[i]

        const blockWidth = block.xmax - block.xmin
        const blockHeight = block.ymax - block.ymin
        if (blockWidth < 20 || blockHeight < 20) continue

        const result = await invoke<InpaintedRegion>('inpaint_region', {
          image: Array.from(new Uint8Array(imageBuffer)),
          mask: Array.from(new Uint8Array(maskBuffer)),
          bbox: {
            xmin: block.xmin,
            ymin: block.ymin,
            xmax: block.xmax,
            ymax: block.ymax,
          },
          padding: 50,
          debugMode,     // Enable debug triptych exports
        })

        const blob = new Blob([new Uint8Array(result.image)])
        const bitmap = await createImageBitmap(blob)

        // *** CRITICAL: Alpha-blended compositing with feathering ***
        await compositeMaskedRegion(
          ctx,
          bitmap,
          result.x,
          result.y,
          result.width,
          result.height,
          block,
          segmentationMask!,
          image!.bitmap.width,
          image!.bitmap.height,
          5 // feather radius
        )

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
      setError(err instanceof Error ? err.message : 'NewLaMa inpainting failed')
    } finally {
      setLoading(false)
      setCurrentBlock(0)
    }
  }

  return (
    <div className='flex w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md'>
      {/* Header */}
      <div className='flex items-center p-3'>
        <h2 className='font-medium'>Inpainting</h2>
        <div className='flex-grow'></div>
        <Button
          onClick={runInpaint}
          loading={loading}
          variant='soft'
          disabled={!image || !segmentationMask || renderMethod === 'rectangle'}
        >
          <Play className='h-4 w-4' />
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
              Rectangle fill doesn't require AI inpainting. Colors will be extracted during Render.
            </Callout.Text>
          </Callout.Root>
        </div>
      )}

      {/* Body */}
      <div className='flex flex-col gap-2 p-3'>
        {/* Info */}
        <div className='text-sm text-gray-600'>
          <p>Removes Japanese text from manga using AI inpainting</p>
        </div>

        {/* Status */}
        <div className='flex flex-col gap-1 text-sm'>
          <div className='flex items-center justify-between'>
            <span>Image:</span>
            <span className={image ? 'text-green-600' : 'text-gray-400'}>
              {image ? '✓ Loaded' : 'Not loaded'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span>Segmentation mask:</span>
            <span className={segmentationMask ? 'text-green-600' : 'text-gray-400'}>
              {segmentationMask ? `✓ Ready (${segmentationMask.length} bytes)` : 'Run detection'}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span>Text regions:</span>
            <span className={textBlocks.length > 0 ? 'text-green-600' : 'text-gray-400'}>
              {textBlocks.length > 0 ? `${textBlocks.length} detected` : 'None'}
            </span>
          </div>
        </div>
        
        {/* Debug Mode Toggle */}
        <div className='flex items-center justify-between text-sm'>
          <label className='flex items-center gap-2 cursor-pointer'>
            <input
              type='checkbox'
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
              className='rounded'
            />
            <span>Debug Mode</span>
          </label>
          {debugMode && (
            <Text size='1' color='gray'>Saves triptych images</Text>
          )}
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
              Text removed successfully! Click "Inpaint" tool to view result.
            </Callout.Text>
          </Callout.Root>
        )}

        {/* Progress for localized/newlama inpainting */}
        {loading && (renderMethod === 'lama' || renderMethod === 'newlama') && (
          <div className='space-y-2'>
            <Progress value={progress * 100} />
            <p className='text-sm text-gray-600'>
              Processing block {currentBlock} of {textBlocks.length}...
            </p>
            <Button size='1' color='red' variant='soft' onClick={() => setCancelled(true)}>
              <X className='h-4 w-4' />
              Cancel
            </Button>
          </div>
        )}

        {/* Loading info for full inpainting */}
        {loading && renderMethod !== 'lama' && renderMethod !== 'newlama' && (
          <div className='text-sm text-gray-600'>
            <p>Processing with LaMa AI model...</p>
            <p className='text-xs'>This may take 5-15 seconds depending on image size.</p>
          </div>
        )}

        {/* Instructions */}
        {!segmentationMask && (
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
