import React, { useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react'
import { useEditorStore } from '@/lib/state'
import { SmartFitText } from './smart-fit-text'
import { detectWritingMode } from '@/utils/writing-mode'

export interface HtmlRenderLayerHandle {
  /** Imperatively sync the overlay transform — call from onDragMove / wheel for 0-lag tracking */
  syncTransform: (x: number, y: number, scale: number) => void
}

interface HtmlRenderLayerProps {
  stageScale: number
  stagePos: { x: number; y: number }
}

export const HtmlRenderLayer = forwardRef<HtmlRenderLayerHandle, HtmlRenderLayerProps>(
  ({ stageScale, stagePos }, ref) => {
  const { tool, currentStage, textBlocks } = useEditorStore()
  const showLayer = tool === 'render' && currentStage === 'final'
  const containerRef = useRef<HTMLDivElement>(null)

  // Expose imperative sync method so the parent canvas can push transform updates
  // directly to the DOM during drag/zoom — bypasses React render cycle entirely.
  const syncTransform = useCallback((x: number, y: number, scale: number) => {
    if (containerRef.current) {
      containerRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    }
  }, [])

  useImperativeHandle(ref, () => ({ syncTransform }), [syncTransform])

  // Keep DOM in sync when React state updates (non-drag path: zoom buttons, fit, etc.)
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.transform = `translate(${stagePos.x}px, ${stagePos.y}px) scale(${stageScale})`
    }
  }, [stagePos.x, stagePos.y, stageScale])

  if (!showLayer) return null

  return (
    <div
      ref={containerRef}
      style={{
        transformOrigin: 'top left',
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        willChange: 'transform',
      }}
    >
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
})

HtmlRenderLayer.displayName = 'HtmlRenderLayer'
