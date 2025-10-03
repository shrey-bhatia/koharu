'use client'

import { useState } from 'react'
import { Play, AlertCircle, CheckCircle } from 'lucide-react'
import { Button, Text, Callout } from '@radix-ui/themes'
import { invoke } from '@tauri-apps/api/core'
import { useEditorStore } from '@/lib/state'
import { imageBitmapToArrayBuffer, maskToArrayBuffer } from '@/utils/image'
import { createImageFromBuffer } from '@/lib/image'

export default function InpaintPanel() {
  const { image, segmentationMask, textBlocks, setInpaintedImage } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const runInpaint = async () => {
    // Validation
    if (!image) {
      setError('No image loaded. Please load a manga image first.')
      return
    }

    if (!segmentationMask) {
      setError('No segmentation mask available. Run Detection first.')
      return
    }

    if (textBlocks.length === 0) {
      setError('No text blocks detected. Run Detection first.')
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      console.log('Starting inpainting...')
      console.log('Image dimensions:', image.bitmap.width, 'x', image.bitmap.height)
      console.log('Mask size:', segmentationMask.length, 'bytes')

      // Convert image to ArrayBuffer (PNG format)
      const imageBuffer = await imageBitmapToArrayBuffer(image.bitmap)
      console.log('Image buffer size:', imageBuffer.byteLength, 'bytes')

      // Convert mask to ArrayBuffer (PNG format)
      const maskBuffer = await maskToArrayBuffer(segmentationMask)
      console.log('Mask buffer size:', maskBuffer.byteLength, 'bytes')

      // Call backend inpaint command
      console.log('Calling inpaint backend...')
      const result = await invoke<number[]>('inpaint', {
        image: Array.from(new Uint8Array(imageBuffer)),
        mask: Array.from(new Uint8Array(maskBuffer)),
      })

      console.log('Inpainting complete! Result size:', result.length, 'bytes')

      // Convert result back to Image
      const resultBuffer = new Uint8Array(result).buffer
      const inpainted = await createImageFromBuffer(resultBuffer)

      setInpaintedImage(inpainted)
      setSuccess(true)
      console.log('Inpainted image stored in state')
    } catch (err) {
      console.error('Inpainting error:', err)
      setError(err instanceof Error ? err.message : 'Inpainting failed')
    } finally {
      setLoading(false)
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
          disabled={!image || !segmentationMask}
        >
          <Play className='h-4 w-4' />
        </Button>
      </div>

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

        {/* Loading info */}
        {loading && (
          <div className='text-sm text-gray-600'>
            <p>Processing with LaMa AI model...</p>
            <p className='text-xs'>This may take 5-15 seconds depending on image size.</p>
          </div>
        )}

        {/* Instructions */}
        {!segmentationMask && (
          <Callout.Root size='1'>
            <Callout.Text>
              <strong>To use inpainting:</strong>
              <ol className='ml-4 mt-1 list-decimal text-xs'>
                <li>Run Detection to find text regions</li>
                <li>Click "Run Inpainting" above</li>
                <li>Wait for processing (5-15 seconds)</li>
                <li>View cleaned image by clicking Inpaint tool</li>
              </ol>
            </Callout.Text>
          </Callout.Root>
        )}
      </div>
    </div>
  )
}
