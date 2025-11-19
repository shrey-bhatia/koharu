import React, { useEffect, useRef, useMemo } from 'react'
import { Layer, Transformer } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEditorStore, type TextBlock } from '@/lib/state'
import { DetectionBlock } from './detection-block'

interface DetectionLayerProps {
  screenSpace: {
    anchorSize: number
    borderStrokeWidth: number
    hitStrokeWidth: number
    padding: number
  }
  isZooming: boolean
  onInteractionStart: () => void
  onInteractionEnd: () => void
}

export const DetectionLayer = ({ 
  screenSpace, 
  isZooming,
  onInteractionStart, 
  onInteractionEnd 
}: DetectionLayerProps) => {
  const {
    tool,
    textBlocks,
    selectedBlockId,
    selectedBlockIndex,
    updateTextBlock,
  } = useEditorStore()

  const transformerRef = useRef<Konva.Transformer>(null)
  const transformerDebounceRef = useRef<NodeJS.Timeout | null>(null)

  const isDetectionMode = tool === 'detection'
  
  const activeSelectionKey = useMemo(() => {
    if (selectedBlockId) return selectedBlockId
    if (selectedBlockIndex != null) return String(selectedBlockIndex)
    return null
  }, [selectedBlockId, selectedBlockIndex])

  // Handle Transformer Attachment
  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return

    if (!isDetectionMode || !activeSelectionKey) {
      transformer.nodes([])
      transformer.getLayer()?.batchDraw()
      return
    }

    // We need to find the node in the stage. 
    // Since we are inside the Layer component, we can use getStage()
    const stage = transformer.getStage()
    if (!stage) return

    const node = stage.findOne(`.region-${activeSelectionKey}`)
    transformer.nodes(node ? [node] : [])
    transformer.getLayer()?.batchDraw()
  }, [activeSelectionKey, isDetectionMode, selectedBlockId, selectedBlockIndex, textBlocks])

  // Debounced transformer redraw during zoom
  useEffect(() => {
    if (!isZooming) {
      transformerRef.current?.getLayer()?.batchDraw()
    } else {
      if (transformerDebounceRef.current) {
        clearTimeout(transformerDebounceRef.current)
      }
      transformerDebounceRef.current = setTimeout(() => {
        transformerRef.current?.getLayer()?.batchDraw()
      }, 150)
    }
  }, [isZooming])

  // Calculate box styles based on screen space
  const boxStyles = useMemo(() => {
    if (!textBlocks) return []
    return textBlocks.map(() => ({
      strokeWidth: screenSpace.borderStrokeWidth,
      hitStrokeWidth: screenSpace.hitStrokeWidth,
      radius: screenSpace.anchorSize / 2 + 2,
      fontSize: Math.max(10, screenSpace.anchorSize),
      labelOffset: screenSpace.anchorSize / 2 + 2
    }))
  }, [textBlocks, screenSpace])

  const handleTransformEnd = (block: TextBlock, index: number, event: KonvaEventObject<Event>) => {
    const node = event.target as Konva.Node
    const scaleX = node.scaleX()
    const scaleY = node.scaleY()
    const x = node.x()
    const y = node.y()

    // Reset scale to 1 to avoid compounding
    node.scaleX(1)
    node.scaleY(1)

    updateTextBlock({ id: block.id, index }, (current) => {
      const width = current.xmax - current.xmin
      const height = current.ymax - current.ymin
      
      const newWidth = Math.max(5, width * scaleX)
      const newHeight = Math.max(5, height * scaleY)

      return {
        ...current,
        xmin: x,
        ymin: y,
        xmax: x + newWidth,
        ymax: y + newHeight,
        ocrStale: true,
      }
    })
  }

  if (!isDetectionMode) return null

  return (
    <Layer>
      {textBlocks?.map((block, index) => (
        <DetectionBlock
          key={`region-${block.id ?? index}`}
          block={block}
          index={index}
          isSelected={
            block.id 
              ? block.id === selectedBlockId 
              : selectedBlockIndex === index
          }
          boxStyle={boxStyles[index]}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
          onTransformEnd={handleTransformEnd}
        />
      ))}
      <Transformer
        ref={transformerRef}
        visible={Boolean(activeSelectionKey)}
        listening={Boolean(activeSelectionKey)}
        ignoreStroke={false}
        rotateEnabled={false}
        anchorSize={screenSpace.anchorSize}
        padding={screenSpace.padding}
        borderStroke='#1976d2'
        borderStrokeWidth={screenSpace.borderStrokeWidth}
        anchorStroke='#1976d2'
        anchorFill='#ffffff'
        anchorCornerRadius={2}
      />
    </Layer>
  )
}
