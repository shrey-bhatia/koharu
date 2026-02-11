'use client'

import { useState } from 'react'
import { Play } from 'lucide-react'
import { Button, Slider, Text } from '@radix-ui/themes'
import { invoke } from '@tauri-apps/api/core'
import { SegmentationMaskInfo, TextBlock, useEditorStore } from '@/lib/state'
import { analyzeTextAppearance } from '@/utils/appearance-analysis'
import { createSegmentationMaskBitmap, imageBitmapToGrayscaleUint8 } from '@/utils/image'

type DetectionResponse = {
  bboxes: TextBlock[]
  maskPng: number[]
  maskWidth: number
  maskHeight: number
}

const generateBlockId = (): string => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined

  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID()
  }

  if (cryptoObj?.getRandomValues) {
    const buffer = new Uint32Array(4)
    cryptoObj.getRandomValues(buffer)
    return Array.from(buffer, (value) => value.toString(16).padStart(8, '0')).join('')
  }

  return `block-${Math.random().toString(36).slice(2, 10)}`
}

const ensureTextBlockIds = (blocks: TextBlock[]): TextBlock[] =>
  blocks.map((block) => (block.id ? block : { ...block, id: generateBlockId() }))

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
    selectBlock,
  } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.5)
  const [nmsThreshold, setNmsThreshold] = useState(0.5)

  const run = async () => {
    if (!image?.buffer) {
      console.warn('Cannot run detection without a loaded image.')
      return
    }

    const sourceImage = image

    setLoading(true)

    try {
      const hadMaskBitmap = Boolean(segmentationMaskBitmap)
      const result = await invoke<DetectionResponse>('detection', {
        image: sourceImage.buffer,
        confidenceThreshold: confidenceThreshold,
        nmsThreshold: nmsThreshold,
      })

    console.log('Detection result:', result)

    let blocks = result?.bboxes ?? []

      // Store segmentation mask for inpainting
      if (result?.maskPng?.length) {
        const maskBytes = new Uint8Array(result.maskPng)
        const maskBlob = new Blob([maskBytes], { type: 'image/png' })
        const maskBitmap = await createImageBitmap(maskBlob)

        const maskArray = await imageBitmapToGrayscaleUint8(maskBitmap)
        maskBitmap.close?.()

        const maskInfo: SegmentationMaskInfo = {
          data: maskArray,
          width: result.maskWidth,
          height: result.maskHeight,
        }

        setSegmentationMask(maskInfo)
        console.log('Segmentation mask stored:', maskArray.length, 'bytes')

        try {
          const overlayBitmap = await createSegmentationMaskBitmap(maskArray, {
            targetWidth: sourceImage.bitmap.width,
            targetHeight: sourceImage.bitmap.height,
            maskWidth: maskInfo.width,
            maskHeight: maskInfo.height,
            alpha: 160,
          })
          setSegmentationMaskBitmap(overlayBitmap)

          if (!hadMaskBitmap && !showSegmentationMask) {
            setShowSegmentationMask(true)
          }
        } catch (maskError) {
          console.error('Failed to prepare segmentation mask preview:', maskError)
          setSegmentationMaskBitmap(null)
        }

        // Run appearance analysis automatically
        if (blocks.length > 0) {
          console.log('Running appearance analysis on', blocks.length, 'blocks...')
          const startTime = performance.now()

          blocks = await analyzeTextAppearance(sourceImage.bitmap, maskArray, blocks, maskInfo.width, maskInfo.height)

          const duration = performance.now() - startTime
          console.log(`Appearance analysis completed in ${duration.toFixed(2)}ms`)
        }
      } else {
        setSegmentationMask(null)
        setSegmentationMaskBitmap(null)
        setShowSegmentationMask(false)
      }

  const blocksWithIds = ensureTextBlockIds(blocks)
  setTextBlocks(blocksWithIds)
      selectBlock(null)
    } catch (error) {
      console.error('Error during detection:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='panel-card flex w-full flex-col'>
      {/* Header */}
      <div className='flex items-center px-4 py-3'>
        <h2 className='text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100'>Detection</h2>
        <div className='flex-grow'></div>
        <Button onClick={run} loading={loading} variant='soft' size='1' color='indigo' style={{ borderRadius: 8 }}>
          <Play className='h-3.5 w-3.5' />
        </Button>
      </div>
      {/* Body */}
      <div className='flex flex-col justify-center'>
        <div className='flex flex-col gap-3 border-t border-gray-100 px-4 py-3 text-sm dark:border-white/[.04]'>
          <div className='flex flex-col gap-1.5'>
            <div className='flex items-center justify-between'>
              <span className='text-xs font-medium text-gray-500 dark:text-gray-400'>Confidence threshold</span>
              <span className='rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-white/[.06] dark:text-gray-200'>{confidenceThreshold}</span>
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
          <div className='flex flex-col gap-1.5'>
            <div className='flex items-center justify-between'>
              <span className='text-xs font-medium text-gray-500 dark:text-gray-400'>NMS threshold</span>
              <span className='rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-white/[.06] dark:text-gray-200'>{nmsThreshold}</span>
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
          <div className='flex flex-col gap-1.5'>
            <div className='flex items-center justify-between'>
              <span className='text-xs font-medium text-gray-500 dark:text-gray-400'>Selection sensitivity</span>
              <span className='rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-white/[.06] dark:text-gray-200'>{selectionSensitivity.toFixed(0)} px</span>
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
            <span className='text-xs font-medium text-gray-500 dark:text-gray-400'>Show detection mask</span>
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
          <Text className='text-xs text-gray-500 dark:text-gray-400'>
            <strong className='text-gray-700 dark:text-gray-200'>{textBlocks.length}</strong> text blocks detected
          </Text>
        </div>
      </div>
    </div>
  )
}
