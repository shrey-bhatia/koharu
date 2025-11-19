import React from 'react'
import { Layer, Image as KonvaImage } from 'react-konva'
import { useEditorStore } from '@/lib/state'

export const BackgroundLayer = () => {
  const {
    image,
    segmentationMaskBitmap,
    showSegmentationMask,
    tool,
    currentStage,
    pipelineStages,
  } = useEditorStore()

  // Determine which image to show based on pipeline stage
  const getBaseImage = () => {
    if (tool === 'render' || tool === 'inpaint') {
      // In render/inpaint modes, respect the pipeline stage
      if (currentStage === 'final' && pipelineStages.final) return pipelineStages.final.bitmap
      if (currentStage === 'rectangles' && pipelineStages.withRectangles) return pipelineStages.withRectangles.bitmap
      if (currentStage === 'textless' && pipelineStages.textless) return pipelineStages.textless.bitmap
    }
    // Default to original image
    return image?.bitmap || null
  }

  const baseImage = getBaseImage()
  const shouldShowMaskOverlay = Boolean(segmentationMaskBitmap && (tool === 'segmentation' || showSegmentationMask))

  return (
    <>
      {/* Layer 1: Base image (respects pipeline stage) */}
      <Layer>
        <KonvaImage image={baseImage} x={0} y={0} />
      </Layer>

      {/* Layer 1.5: Segmentation overlay */}
      {shouldShowMaskOverlay && (
        <Layer listening={false} opacity={0.6}>
          <KonvaImage image={segmentationMaskBitmap || null} x={0} y={0} listening={false} />
        </Layer>
      )}
    </>
  )
}
