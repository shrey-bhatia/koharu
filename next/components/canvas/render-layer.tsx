import React from 'react'
import { Layer, Rect } from 'react-konva'
import { useEditorStore } from '@/lib/state'

export const RenderLayer = () => {
  const { tool, currentStage, textBlocks } = useEditorStore()
  // We now use HtmlRenderLayer for text rendering in the UI
  // This layer is kept for rectangle rendering or future canvas-specific needs
  const showRenderRectanglesLayer = tool === 'render' && currentStage === 'withRectangles'

  if (!showRenderRectanglesLayer) return null

  return (
    <Layer>
      {textBlocks?.map((block, index) => {
        if (!block.backgroundColor) return null

        const bg = block.manualBgColor || block.backgroundColor
        const { xmin, ymin, xmax, ymax } = block
        const width = xmax - xmin
        const height = ymax - ymin

        return (
          <React.Fragment key={`fill-${index}`}>
             <Rect
                x={xmin}
                y={ymin}
                width={width}
                height={height}
                fill={`rgb(${bg.r}, ${bg.g}, ${bg.b})`}
                cornerRadius={5}
              />
          </React.Fragment>
        )
      })}
    </Layer>
  )
}
