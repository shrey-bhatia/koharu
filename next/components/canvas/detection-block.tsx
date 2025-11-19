import React, { useCallback, useRef } from 'react'
import { Group, Rect, Circle, Text } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEditorStore, type TextBlock } from '@/lib/state'

// Helper to check for startDrag method safely
const hasStartDrag = (node: Konva.Node | null): node is Konva.Node & { startDrag: () => void } => {
  if (!node) return false
  const candidate = node as Konva.Node & { startDrag?: unknown }
  return typeof candidate.startDrag === 'function'
}

interface DetectionBlockProps {
  block: TextBlock
  index: number
  isSelected: boolean
  boxStyle: {
    strokeWidth: number
    hitStrokeWidth: number
    radius: number
    fontSize: number
    labelOffset: number
  }
  onInteractionStart: () => void
  onInteractionEnd: () => void
  onTransformEnd: (block: TextBlock, index: number, event: KonvaEventObject<Event>) => void
}

export const DetectionBlock = React.memo(({
  block,
  index,
  isSelected,
  boxStyle,
  onInteractionStart,
  onInteractionEnd,
  onTransformEnd
}: DetectionBlockProps) => {
  const {
    updateTextBlock,
    setSelectedBlockIndex,
    setSelectedBlockId,
    selectedBlockId,
    selectedBlockIndex
  } = useEditorStore()

  const isDraggingRef = useRef(false)

  const { xmin, ymin, xmax, ymax } = block
  const width = xmax - xmin
  const height = ymax - ymin
  const regionKey = block.id ?? String(index)

  const strokeColor = isSelected
    ? '#1976d2'
    : block.ocrStale
      ? '#f97316'
      : '#e11d48'

  const labelOffset = boxStyle.labelOffset
  const labelX = -labelOffset
  const labelY = -labelOffset
  const labelDiameter = boxStyle.radius * 2

  const handlePointerDown = useCallback(
    (event: KonvaEventObject<Event>) => {
      // 1. Signal interaction start (locks stage)
      onInteractionStart()
      isDraggingRef.current = false

      // 2. Handle Selection
      const blockIdOrNull = block.id ?? null
      const alreadySelectedById = selectedBlockId === blockIdOrNull
      const alreadySelectedByIndex = selectedBlockIndex === index

      if (!alreadySelectedByIndex) {
        setSelectedBlockIndex(index)
      }
      if (!alreadySelectedById) {
        setSelectedBlockId(blockIdOrNull)
      }
      
      event.cancelBubble = true

      // 3. Handle Drag Initiation
      // Check if this is a transformer interaction
      const isTransformerChild = Boolean(
        (event.target as Konva.Node | null)?.getParent?.()?.getClassName?.() === 'Transformer'
      )
      
      // Only auto-start drag if NOT interacting with transformer
      const shouldAutoDrag = !isTransformerChild

      const potentialGroup = event.currentTarget as Konva.Node | null
      const dragNode = hasStartDrag(potentialGroup)
        ? potentialGroup
        : (event.target as Konva.Node | null)

      if (shouldAutoDrag && hasStartDrag(dragNode)) {
        const wasDraggable = dragNode.draggable()
        if (!wasDraggable) {
          dragNode.draggable(true)
        }
        dragNode.startDrag()
        if (!wasDraggable) {
          dragNode.draggable(false)
        }
      }
    },
    [block.id, index, onInteractionStart, selectedBlockId, selectedBlockIndex, setSelectedBlockId, setSelectedBlockIndex]
  )

  return (
    <Group
      name={`region-${regionKey}`}
      data-block-id={block.id ?? undefined}
      x={xmin}
      y={ymin}
      width={width}
      height={height}
      draggable
      onPointerDown={handlePointerDown}
      onClick={handlePointerDown}
      onTap={handlePointerDown}
      onPointerUp={(e) => {
        if (!isDraggingRef.current) {
          onInteractionEnd()
        }
        e.cancelBubble = true
      }}
      onDragMove={(e) => {
        e.cancelBubble = true
        if (!isDraggingRef.current) {
          isDraggingRef.current = true
        }
      }}
      onDragEnd={(e) => {
        e.cancelBubble = true
        const node = e.target as Konva.Node
        const newX = node.x()
        const newY = node.y()

        updateTextBlock(
          { id: block.id, index },
          (current) => {
            const currentWidth = current.xmax - current.xmin
            const currentHeight = current.ymax - current.ymin
            return {
              ...current,
              xmin: newX,
              ymin: newY,
              xmax: newX + currentWidth,
              ymax: newY + currentHeight,
              ocrStale: true,
            }
          }
        )
        isDraggingRef.current = false
        onInteractionEnd()
      }}
      onTransformStart={() => {
        // Lock stage during transform
        onInteractionStart()
      }}
      onTransformEnd={(e) => {
        e.cancelBubble = true
        onTransformEnd(block, index, e)
        isDraggingRef.current = false
        onInteractionEnd()
      }}
    >
      <Rect
        // Nearly invisible fill ensures the entire box is draggable/selectable
        x={0}
        y={0}
        width={width}
        height={height}
        fill='black'
        opacity={0.001}
      />
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        stroke={strokeColor}
        strokeWidth={boxStyle.strokeWidth}
        strokeScaleEnabled={false}
        perfectDrawEnabled={false}
        hitStrokeWidth={boxStyle.hitStrokeWidth}
      />
      <Circle
        x={labelX}
        y={labelY}
        radius={boxStyle.radius}
        fill='rgba(255, 0, 0, 0.7)'
        listening={false}
      />
      <Text
        x={labelX}
        y={labelY}
        text={(index + 1).toString()}
        fontSize={boxStyle.fontSize}
        fill='white'
        fontFamily='sans-serif'
        width={labelDiameter}
        height={labelDiameter}
        offsetX={labelDiameter / 2}
        offsetY={labelDiameter / 2}
        align='center'
        verticalAlign='middle'
        listening={false}
      />
    </Group>
  )
})

DetectionBlock.displayName = 'DetectionBlock'
