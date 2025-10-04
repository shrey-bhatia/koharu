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
  const { tool, scale, image, textBlocks, setTextBlocks, inpaintedImage, selectedBlockIndex, setSelectedBlockIndex } = useEditorStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const inpaintLayerRef = useRef<Konva.Layer>(null)

  const [selected, setSelected] = useState<any>(null)

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
              {/* Layer 1: Original image */}
              <Layer>
                <Image image={image?.bitmap ?? null} />
              </Layer>

              {/* Layer 2: Rectangle fills (render mode) */}
              {tool === 'render' && (
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

              {/* Layer 3: Translated text (render mode) */}
              {tool === 'render' && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    if (!block.translatedText || !block.fontSize || !block.textColor) return null

                    const textColor = block.manualTextColor || block.textColor
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin

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
                          stroke={selectedBlockIndex === index ? 'blue' : 'red'}
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
                            }
                            setTextBlocks(updated)
                          }}
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
                  {selected && <Transformer nodes={[selected]} />}
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
