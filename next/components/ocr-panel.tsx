'use client'

import { Play, AlertTriangle } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { Badge, Button, Text, Callout } from '@radix-ui/themes'
import { crop, imageBitmapToArrayBuffer } from '@/utils/image'
import { useEditorStore } from '@/lib/state'
import { invoke } from '@tauri-apps/api/core'

export default function OCRPanel() {
  const { image, textBlocks, setTextBlocks } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const autoOcrTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const staleCount = textBlocks.filter(b => b.ocrStale).length

  // Auto-trigger OCR when boxes become stale (with debounce)
  useEffect(() => {
    if (staleCount > 0 && !loading) {
      // Clear existing timeout
      if (autoOcrTimeoutRef.current) {
        clearTimeout(autoOcrTimeoutRef.current)
      }

      // Set new timeout - run OCR after 1.5 seconds of no changes
      autoOcrTimeoutRef.current = setTimeout(() => {
        console.log(`Auto-triggering OCR for ${staleCount} stale box(es)`)
        run()
      }, 1500)
    }

    return () => {
      if (autoOcrTimeoutRef.current) {
        clearTimeout(autoOcrTimeoutRef.current)
      }
    }
  }, [staleCount, loading])

  const run = async () => {
    if (!image || !textBlocks.length) return

    setLoading(true)
    try {
      const updatedBlocks = []
      for (const block of textBlocks) {
        const { xmin, ymin, xmax, ymax } = block
        const croppedBitmap = await crop(
          image.bitmap,
          Math.floor(xmin),
          Math.floor(ymin),
          Math.floor(xmax - xmin),
          Math.floor(ymax - ymin)
        )
        const croppedBuffer = await imageBitmapToArrayBuffer(croppedBitmap)
        const ocrResults = await invoke<string[]>('ocr', { image: Array.from(new Uint8Array(croppedBuffer)) })
        const result = ocrResults.length > 0 ? ocrResults[0] : ''
        updatedBlocks.push({ ...block, text: result, ocrStale: false }) // Clear stale flag
      }
      setTextBlocks(updatedBlocks)
    } catch (error) {
      console.error('Error during OCR:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='flex max-h-[600px] w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md'>
      {/* Header */}
      <div className='flex flex-shrink-0 items-center-safe p-3'>
        <h2 className='font-medium'>OCR</h2>
        <div className='flex-grow'></div>
        <Button onClick={run} loading={loading} variant='soft'>
          <Play className='h-4 w-4' />
        </Button>
      </div>

      {/* Stale OCR Warning */}
      {staleCount > 0 && !loading && (
        <div className='px-3 pb-2'>
          <Callout.Root size='1' color='orange'>
            <Callout.Icon>
              <AlertTriangle className='h-3 w-3' />
            </Callout.Icon>
            <Callout.Text>
              {staleCount} box{staleCount > 1 ? 'es' : ''} moved. Auto-refreshing OCR...
            </Callout.Text>
          </Callout.Root>
        </div>
      )}

      <div className='flex flex-col overflow-y-auto'>
        {textBlocks?.map((block, index) => (
          <div
            key={index}
            className={`cursor-pointer border-b border-gray-200 px-4 py-2 text-sm last:border-b-0 ${
              block.ocrStale ? 'bg-orange-50' : ''
            }`}
          >
            <Text className='flex gap-2 items-center'>
              <Badge color={block.ocrStale ? 'orange' : undefined}>{index + 1}</Badge>
              {block.ocrStale && <AlertTriangle className='h-3 w-3 text-orange-500' />}
              {block.text || 'No text detected'}
            </Text>
          </div>
        ))}
      </div>
    </div>
  )
}
