'use client'

import type Konva from 'konva'
import { useState, useRef } from 'react'
import {
  Circle,
  Image,
  Layer,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva'
import ScaleControl from './scale-control'
import { useEditorStore } from '@/lib/state'

function Canvas() {
  const { tool, scale, image, textBlocks, setTextBlocks, inpaintedImage, selectedBlockIndex, setSelectedBlockIndex, currentStage, pipelineStages } = useEditorStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const inpaintLayerRef = useRef<Konva.Layer>(null)

  const [selected, setSelected] = useState<any>(null)
  const transformerRef = useRef<Konva.Transformer>(null)

  // Handler for when a box is transformed (scaled/rotated/resized)
  const handleTransformEnd = (index: number) => {
    const node = selected
    if (!node) return

    const scaleX = node.scaleX()
    const scaleY = node.scaleY()

    // Get the current position after transformation
    const x = node.x()
    const y = node.y()
    const width = node.width() * scaleX
    const height = node.height() * scaleY

    // Reset the scale to 1 (we've already applied it to width/height)
    node.scaleX(1)
    node.scaleY(1)

    // Update state with new dimensions
    const updated = [...textBlocks]
    updated[index] = {
      ...updated[index],
      xmin: x,
      ymin: y,
      xmax: x + width,
      ymax: y + height,
      ocrStale: true, // Mark as stale when resized
    }
    setTextBlocks(updated)
  }

  // Determine which base image to display based on currentStage
  const getBaseImage = () => {
    if (tool === 'inpaint' && inpaintedImage) {
      return inpaintedImage.bitmap
    }

    switch (currentStage) {
      case 'textless':
        return pipelineStages.textless?.bitmap || image?.bitmap || null
      case 'rectangles':
        return pipelineStages.withRectangles?.bitmap || pipelineStages.textless?.bitmap || image?.bitmap || null
      case 'final':
        return pipelineStages.final?.bitmap || image?.bitmap || null
      case 'original':
      default:
        return image?.bitmap || null
    }
  }

  const baseImage = getBaseImage()
  const shouldShowOverlays = tool === 'render' && (currentStage === 'rectangles' || currentStage === 'final')

  return (
    <>
      <div ref={containerRef} className='relative h-full w-full flex-1'>
        <div className='absolute inset-0 flex items-center-safe justify-center-safe overflow-auto'>
          <div className='p-2'>
            <Stage
              scaleX={scale}
              scaleY={scale}
              width={image?.bitmap.width * scale || 0}
              height={image?.bitmap.height * scale || 0}
              onClick={() => {
                setSelected(null)
              }}
            >
              {/* Layer 1: Base image (respects pipeline stage) */}
              <Layer>
                <Image image={baseImage} />
              </Layer>

              {/* Layer 2: Rectangle fills (render mode, only for 'rectangles' and 'final' stages) */}
              {shouldShowOverlays && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    if (!block.backgroundColor) return null

                    const bg = block.manualBgColor || block.backgroundColor
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin

                    return (
                      <Rect
                        key={`fill-${index}`}
                        x={xmin}
                        y={ymin}
                        width={width}
                        height={height}
                        fill={`rgb(${bg.r}, ${bg.g}, ${bg.b})`}
                        cornerRadius={5}
                      />
                    )
                  })}
                </Layer>
              )}

              {/* Layer 3: Translated text (render mode, only for 'final' stage) */}
              {tool === 'render' && currentStage === 'final' && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    if (!block.translatedText || !block.fontSize || !block.textColor) return null

                    const textColor = block.manualTextColor || block.textColor
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin

                    // Check for outline from appearance analysis
                    const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
                    const outlineColor = hasOutline ? block.appearance.sourceOutlineColor : undefined
                    const outlineWidth = hasOutline ? block.appearance.outlineWidthPx : undefined

                    return (
                      <Text
                        key={`translated-${index}`}
                        x={xmin}
                        y={ymin}
                        width={width}
                        height={height}
                        text={block.translatedText}
                        fontSize={block.fontSize}
                        fontFamily={block.fontFamily || 'Arial'}
                        fill={`rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`}
                        stroke={outlineColor ? `rgb(${outlineColor.r}, ${outlineColor.g}, ${outlineColor.b})` : undefined}
                        strokeWidth={outlineWidth}
                        align='center'
                        verticalAlign='middle'
                        wrap='word'
                      />
                    )
                  })}
                </Layer>
              )}

              {/* Layer 4: Detection boxes (detection mode) */}
              {tool === 'detection' && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin

                    return (
                      <>
                        <Rect
                          key={`rect-${index}`}
                          x={xmin}
                          y={ymin}
                          width={width}
                          height={height}
                          stroke={
                            selectedBlockIndex === index
                              ? 'blue'
                              : block.ocrStale
                                ? 'orange'
                                : 'red'
                          }
                          strokeWidth={(selectedBlockIndex === index ? 3 : 2) / scale}
                          strokeScaleEnabled={false}
                          onClick={(e) => {
                            e.cancelBubble = true
                            setSelectedBlockIndex(index)
                            setSelected(e.target)
                          }}
                          draggable={true}
                          onDragEnd={(e) => {
                            const updated = [...textBlocks]
                            const newX = e.target.x()
                            const newY = e.target.y()
                            updated[index] = {
                              ...updated[index],
                              xmin: newX,
                              ymin: newY,
                              xmax: newX + width,
                              ymax: newY + height,
                              ocrStale: true, // Mark as stale when moved
                            }
                            setTextBlocks(updated)
                          }}
                          onTransformEnd={() => handleTransformEnd(index)}
                        />
                        <Circle
                          key={`circle-${index}`}
                          x={xmin}
                          y={ymin}
                          radius={20 / scale}
                          fill='rgba(255, 0, 0, 0.7)'
                          listening={false}
                        />
                        <Text
                          key={`text-${index}`}
                          x={xmin - 10 / scale}
                          y={ymin - 15 / scale}
                          text={(index + 1).toString()}
                          fontSize={30 / scale}
                          fill='white'
                          fontFamily='sans-serif'
                          listening={false}
                        />
                      </>
                    )
                  })}
                  {selected && <Transformer ref={transformerRef} nodes={[selected]} />}
                </Layer>
              )}
              <Layer>{tool === 'segmentation' && <Image image={null} />}</Layer>
              <Layer ref={inpaintLayerRef}>
                {tool === 'inpaint' && inpaintedImage && (
                  <Image image={inpaintedImage.bitmap} />
                )}
              </Layer>
            </Stage>
          </div>
        </div>
      </div>
      <ScaleControl />
    </>
  )
}

export default Canvas
