'use client'

import { Play } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Text } from '@radix-ui/themes'
import { crop, imageBitmapToArrayBuffer } from '@/utils/image'
import { useEditorStore } from '@/lib/state'
import { invoke } from '@tauri-apps/api/core'

export default function OCRPanel() {
  const { image, textBlocks, setTextBlocks } = useEditorStore()
  const [loading, setLoading] = useState(false)

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
        const result = await invoke<string>('ocr', { image: Array.from(new Uint8Array(croppedBuffer)) })
        updatedBlocks.push({ ...block, text: result })
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
      <div className='flex flex-col overflow-y-auto'>
        {textBlocks?.map((block, index) => (
          <div
            key={index}
            className='cursor-pointer border-b border-gray-200 px-4 py-2 text-sm last:border-b-0'
          >
            <Text className='flex gap-2'>
              <Badge>{index + 1}</Badge>
              {block.text || 'No text detected'}
            </Text>
          </div>
        ))}
      </div>
    </div>
  )
}
