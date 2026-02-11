import React, { useLayoutEffect, useRef, useState, useMemo } from 'react'
import { DiamondWrapper } from './diamond-wrapper'

interface SmartFitTextProps {
  text: string
  width: number
  height: number
  isVertical: boolean
  /** If set, use this font size directly instead of auto-calculating */
  fixedFontSize?: number
  minFontSize?: number
  maxFontSize?: number
  style?: React.CSSProperties
  className?: string
}

export const SmartFitText = ({
  text,
  width,
  height,
  isVertical,
  fixedFontSize,
  minFontSize = 12,
  maxFontSize = 200,
  style,
  className,
}: SmartFitTextProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [fontSize, setFontSize] = useState<number>(() => {
    // If a fixed size is provided (from processColors), use it directly
    if (fixedFontSize) return fixedFontSize
    // Initial Heuristic Guess
    const charCount = text.length || 1
    const availableArea = width * height * 0.5
    const estimatedSize = Math.sqrt(availableArea / charCount)
    return Math.max(minFontSize, Math.min(maxFontSize, Math.floor(estimatedSize)))
  })

  useLayoutEffect(() => {
    // If fixedFontSize is provided, use it directly — no binary search needed
    if (fixedFontSize) {
      if (fixedFontSize !== fontSize) setFontSize(fixedFontSize)
      return
    }

    const container = containerRef.current
    if (!container) return

    // If dimensions are too small, don't bother
    if (width < 20 || height < 20) return

    // Binary Search Optimization
    // We want the largest font size where scrollHeight <= clientHeight
    
    let low = minFontSize
    let high = maxFontSize
    let bestFit = low

    // Heuristic start:
    // If current fits, try bigger. If not, try smaller.
    // But full binary search is safer to guarantee optimality.
    
    // Optimization: Limit iterations. 
    // 5 iterations gives us 32x precision range (e.g. 32px range -> 1px precision)
    // 7 iterations gives 128x range.
    const iterations = 6

    // We need to manipulate the DOM directly for the search to avoid React render cycles
    // This is "The Right Way" for layout-dependent sizing without thrashing React
    
    // Helper to check fit
    const checkFit = (size: number) => {
      container.style.fontSize = `${size}px`
      
      // Check 1: Vertical Overflow (Height)
      // For vertical text, this is actually checking width overflow (scrollWidth)
      // For horizontal text, this is checking height overflow (scrollHeight)
      const hasMainAxisOverflow = isVertical 
        ? container.scrollWidth > container.clientWidth + 2
        : container.scrollHeight > container.clientHeight + 2

      if (hasMainAxisOverflow) return false

      // Check 2: Horizontal Overflow (Width) - CRITICAL for "No Split Words"
      // If a single word is wider than the container (or the diamond gap),
      // it will cause scrollWidth > clientWidth in horizontal mode.
      // We must catch this to force font shrinking.
      if (!isVertical) {
        if (container.scrollWidth > container.clientWidth + 2) return false
      } else {
        if (container.scrollHeight > container.clientHeight + 2) return false
      }

      return true
    }

    // Perform search
    for (let i = 0; i < iterations; i++) {
      const mid = Math.floor((low + high) / 2)
      if (checkFit(mid)) {
        bestFit = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    // Final check to ensure we didn't end on an overflow state
    if (!checkFit(bestFit)) {
      bestFit = Math.max(minFontSize, bestFit - 1)
    }

    // Apply final result
    // Only update state if it changed significantly to avoid loops
    if (bestFit !== fontSize) {
      setFontSize(bestFit)
    } else {
      // Restore style if state didn't change (React won't re-render, so we must reset DOM)
      container.style.fontSize = `${bestFit}px`
    }

  }, [text, width, height, isVertical, fixedFontSize, minFontSize, maxFontSize, fontSize])

  const combinedStyle: React.CSSProperties = useMemo(() => ({
    ...style,
    fontSize: `${fontSize}px`,
    width: '100%',
    height: '100%',
    overflow: 'hidden', // Hide scrollbars during measurement
    
    // CRITICAL: Prevent splitting words
    overflowWrap: 'normal', 
    wordBreak: 'normal',
    whiteSpace: 'pre-wrap',
    
    hyphens: 'auto', // Enable hyphenation
    lineHeight: style?.lineHeight || 1.2,
    
    // Add padding to keep text away from the dangerous 0-width corners
    padding: isVertical ? '10% 5%' : '5% 10%',
    boxSizing: 'border-box',
  }), [style, fontSize, isVertical])

  return (
    <div 
      ref={containerRef} 
      style={combinedStyle} 
      className={className}
    >
      <DiamondWrapper isVertical={isVertical} debug={false}>
        {text}
      </DiamondWrapper>
    </div>
  )
}
