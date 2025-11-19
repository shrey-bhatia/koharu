import React, { useMemo } from 'react'
import { useEditorStore } from '@/lib/state'
import { SmartFitText } from './smart-fit-text'
import { detectWritingMode } from '@/utils/writing-mode'

interface HtmlRenderLayerProps {
  stageScale: number
  stagePos: { x: number; y: number }
}

export const HtmlRenderLayer = ({ stageScale, stagePos }: HtmlRenderLayerProps) => {
  const { tool, currentStage, textBlocks } = useEditorStore()
  const showLayer = tool === 'render' && currentStage === 'final'

  // Memoize the container style to prevent thrashing
  const containerStyle = useMemo(() => ({
    transform: `translate(${stagePos.x}px, ${stagePos.y}px) scale(${stageScale})`,
    transformOrigin: 'top left',
    width: '100%',
    height: '100%',
    position: 'absolute' as const,
    top: 0,
    left: 0,
    pointerEvents: 'none' as const, // Let clicks pass through to canvas
    willChange: 'transform'
  }), [stageScale, stagePos])

  if (!showLayer) return null

  return (
    <div style={containerStyle}>
      {textBlocks?.map((block, index) => {
        if (!block.translatedText) return null

        const { xmin, ymin, xmax, ymax } = block
        const width = xmax - xmin
        const height = ymax - ymin
        
        // Smart detection of writing mode
        const writingMode = detectWritingMode(block.translatedText, width, height)
        const isVertical = writingMode === 'vertical-rl'
        
        // Styling
        // const fontSize = block.fontSize || 16
        const color = block.manualTextColor || block.textColor || { r: 0, g: 0, b: 0 }
        const fontFamily = block.fontFamily || 'Arial'
        
        // Outline logic (CSS text-shadow is better than -webkit-text-stroke for this)
        const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
        const outlineColor = hasOutline ? block.appearance.sourceOutlineColor : { r: 255, g: 255, b: 255 }
        const outlineWidth = hasOutline ? (block.appearance?.outlineWidthPx || 3) : 3
        
        // Create a high-quality outline using text-shadow
        // We stack shadows to create a solid stroke
        const r = outlineColor.r
        const g = outlineColor.g
        const b = outlineColor.b
        const w = outlineWidth
        const shadowColor = `rgb(${r},${g},${b})`
        
        // 8-point shadow for robust outline
        const textShadow = `
          -${w}px -${w}px 0 ${shadowColor},
           0   -${w}px 0 ${shadowColor},
           ${w}px -${w}px 0 ${shadowColor},
           ${w}px  0   0 ${shadowColor},
           ${w}px  ${w}px 0 ${shadowColor},
           0    ${w}px 0 ${shadowColor},
          -${w}px  ${w}px 0 ${shadowColor},
          -${w}px  0   0 ${shadowColor}
        `

        return (
          <div
            key={block.id || index}
            style={{
              position: 'absolute',
              left: `${xmin}px`,
              top: `${ymin}px`,
              width: `${width}px`,
              height: `${height}px`,
              writingMode: isVertical ? 'vertical-rl' : 'horizontal-tb',
              
              // Font styles handled by SmartFitText now
              // fontFamily: fontFamily,
              // fontSize: `${fontSize}px`,
              // color: `rgb(${color.r}, ${color.g}, ${color.b})`,
              // lineHeight: block.lineHeight || 1.2,
              // letterSpacing: `${block.letterSpacing || 0}px`,
              // textAlign: 'center',
              // whiteSpace: 'pre-wrap', // Allow manual line breaks
              // textShadow: textShadow,
              
              // "Inked" look
              mixBlendMode: 'multiply', 
              
              // overflow: 'hidden', // Handled by SmartFitText
            }}
          >
            <SmartFitText
              text={block.translatedText}
              width={width}
              height={height}
              isVertical={isVertical}
              style={{
                fontFamily: fontFamily,
                color: `rgb(${color.r}, ${color.g}, ${color.b})`,
                lineHeight: block.lineHeight || 1.2,
                letterSpacing: `${block.letterSpacing || 0}px`,
                textAlign: 'center',
                whiteSpace: 'pre-wrap',
                textShadow: textShadow,
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
