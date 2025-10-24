'use client'

import { useState } from 'react'
import { Play } from 'lucide-react'
import { Button, Slider, Text } from '@radix-ui/themes'
import { invoke } from '@tauri-apps/api/core'
import { TextBlock, useEditorStore } from '@/lib/state'
import { analyzeTextAppearance } from '@/utils/appearance-analysis'
import { createSegmentationMaskBitmap } from '@/utils/image'

export default function DetectionPanel() {
  const {
    image,
    textBlocks,
    setTextBlocks,
    setSegmentationMask,
    setSegmentationMaskBitmap,
    segmentationMaskBitmap,
    showSegmentationMask,
    setShowSegmentationMask,
    selectionSensitivity,
    setSelectionSensitivity,
  } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.5)
  const [nmsThreshold, setNmsThreshold] = useState(0.5)

  const run = async () => {
    setLoading(true)

    try {
      const hadMaskBitmap = Boolean(segmentationMaskBitmap)
      const result = await invoke<{ bboxes: TextBlock[]; segment?: number[] }>('detection', {
        image: image.buffer,
        confidenceThreshold: confidenceThreshold,
        nmsThreshold: nmsThreshold,
      })

      console.log('Detection result:', result)

  let blocks = result?.bboxes || []

      // Store segmentation mask for inpainting
      if (result?.segment) {
        setSegmentationMask(result.segment)
        console.log('Segmentation mask stored:', result.segment.length, 'bytes')

        if (image?.bitmap) {
          try {
            const maskBitmap = await createSegmentationMaskBitmap(result.segment, {
              targetWidth: image.bitmap.width,
              targetHeight: image.bitmap.height,
              alpha: 160,
            })
            setSegmentationMaskBitmap(maskBitmap)

            if (!hadMaskBitmap && !showSegmentationMask) {
              setShowSegmentationMask(true)
            }
          } catch (maskError) {
            console.error('Failed to prepare segmentation mask preview:', maskError)
            setSegmentationMaskBitmap(null)
          }
        }

        // Run appearance analysis automatically
        if (blocks.length > 0 && image?.bitmap) {
          console.log('Running appearance analysis on', blocks.length, 'blocks...')
          const startTime = performance.now()

          blocks = await analyzeTextAppearance(image.bitmap, result.segment, blocks)

          const duration = performance.now() - startTime
          console.log(`Appearance analysis completed in ${duration.toFixed(2)}ms`)
        }
      } else {
        setSegmentationMask(null)
        setSegmentationMaskBitmap(null)
        setShowSegmentationMask(false)
      }

      if (blocks.length > 0) {
        setTextBlocks(blocks)
      }
    } catch (error) {
      console.error('Error during detection:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='flex w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md dark:border-gray-700 dark:bg-gray-800'>
      {/* Header */}
      <div className='flex items-center p-3'>
        <h2 className='font-medium text-gray-900 dark:text-gray-100'>Detection</h2>
        <div className='flex-grow'></div>
        <Button onClick={run} loading={loading} variant='soft'>
          <Play className='h-4 w-4' />
        </Button>
      </div>
      {/* Body */}
      <div className='flex flex-col justify-center'>
        <div className='flex flex-col gap-2 border-b border-gray-200 px-4 py-2 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300'>
          <div className='flex flex-col gap-1'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-gray-800 dark:text-gray-100'>Confidence threshold</span>
              <span className='font-mono text-gray-900 dark:text-gray-100'>{confidenceThreshold}</span>
            </div>
            <Slider
              size='1'
              min={0}
              max={1}
              step={0.01}
              value={[confidenceThreshold]}
              onValueChange={(value) => setConfidenceThreshold(value[0])}
            />
          </div>
          <div className='flex flex-col gap-1'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-gray-800 dark:text-gray-100'>NMS threshold</span>
              <span className='font-mono text-gray-900 dark:text-gray-100'>{nmsThreshold}</span>
            </div>
            <Slider
              size='1'
              min={0}
              max={1}
              step={0.01}
              value={[nmsThreshold]}
              onValueChange={(value) => setNmsThreshold(value[0])}
            />
          </div>
          <div className='flex flex-col gap-1'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-gray-800 dark:text-gray-100'>Selection sensitivity</span>
              <span className='font-mono text-gray-900 dark:text-gray-100'>{selectionSensitivity.toFixed(0)} px</span>
            </div>
            <Slider
              size='1'
              min={10}
              max={36}
              step={1}
              value={[selectionSensitivity]}
              onValueChange={(value) => setSelectionSensitivity(value[0])}
            />
          </div>
          <div className='flex items-center justify-between'>
            <span className='font-medium text-gray-800 dark:text-gray-100'>Show detection mask</span>
            <Button
              size='1'
              variant={showSegmentationMask ? 'solid' : 'soft'}
              color='indigo'
              onClick={() => setShowSegmentationMask(!showSegmentationMask)}
              disabled={!segmentationMaskBitmap}
            >
              {showSegmentationMask ? 'On' : 'Off'}
            </Button>
          </div>
          <Text className='text-gray-700 dark:text-gray-300'>
            <strong>{textBlocks.length}</strong> text blocks detected
          </Text>
        </div>
      </div>
    </div>
  )
}
