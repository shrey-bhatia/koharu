import React from 'react'
import { Layer, Text } from 'react-konva'
import { useEditorStore } from '@/lib/state'

export const RenderLayer = () => {
  const { tool, currentStage, textBlocks } = useEditorStore()
  const showRenderTextLayer = tool === 'render' && currentStage === 'final'

  if (!showRenderTextLayer) return null

  return (
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
            letterSpacing={block.letterSpacing}
            lineHeight={block.lineHeight}
            align='center'
            verticalAlign='middle'
            wrap='word'
          />
        )
      })}
    </Layer>
  )
}
