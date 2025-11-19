import React from 'react'

interface DiamondWrapperProps {
  width?: number
  height?: number
  isVertical: boolean
  children: React.ReactNode
  debug?: boolean
}

export const DiamondWrapper = ({ isVertical, children, debug }: DiamondWrapperProps) => {
  // CSS Polygons for Diamond Shape
  // These define the "exclusion zones" - the corners we want to block out.
  
  // Horizontal: Spacers are Left and Right halves
  const hLeftPoly = 'polygon(0% 0%, 100% 0%, 0% 50%, 100% 100%, 0% 100%)'
  const hRightPoly = 'polygon(100% 0%, 0% 0%, 100% 50%, 0% 100%, 100% 100%)'
  
  // Vertical: Spacers are Top and Bottom halves
  // Note: In vertical-rl, 'float: left' is physically Top, 'float: right' is physically Bottom
  const vTopPoly = 'polygon(0% 0%, 100% 0%, 100% 100%, 50% 0%, 0% 100%)'
  const vBottomPoly = 'polygon(0% 100%, 100% 100%, 100% 0%, 50% 100%, 0% 0%)'

  const spacerStyle: React.CSSProperties = {
    position: 'relative', // Floats need to be in flow
    background: debug ? 'rgba(255, 0, 0, 0.2)' : 'transparent',
  }

  if (isVertical) {
    return (
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        {/* Top Spacer (Physical Top / Line Left) */}
        <div
          style={{
            ...spacerStyle,
            float: 'left',
            width: '100%',
            height: '50%',
            shapeOutside: vTopPoly,
            clipPath: debug ? vTopPoly : undefined,
          }}
        />
        {/* Bottom Spacer (Physical Bottom / Line Right) */}
        <div
          style={{
            ...spacerStyle,
            float: 'right',
            width: '100%',
            height: '50%',
            shapeOutside: vBottomPoly,
            clipPath: debug ? vBottomPoly : undefined,
          }}
        />
        {/* Content flows between them */}
        {children}
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Left Spacer */}
      <div
        style={{
          ...spacerStyle,
          float: 'left',
          width: '50%',
          height: '100%',
          shapeOutside: hLeftPoly,
          clipPath: debug ? hLeftPoly : undefined,
        }}
      />
      {/* Right Spacer */}
      <div
        style={{
          ...spacerStyle,
          float: 'right',
          width: '50%',
          height: '100%',
          shapeOutside: hRightPoly,
          clipPath: debug ? hRightPoly : undefined,
        }}
      />
      {children}
    </div>
  )
}
