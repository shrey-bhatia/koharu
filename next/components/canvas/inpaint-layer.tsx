import React from 'react'
import { Layer, Image as KonvaImage } from 'react-konva'
import { useEditorStore } from '@/lib/state'

export const InpaintLayer = () => {
  const { tool, inpaintedImage } = useEditorStore()
  const showInpaintLayer = tool === 'inpaint' && inpaintedImage

  if (!showInpaintLayer) return null

  return (
    <Layer>
      <KonvaImage image={inpaintedImage.bitmap} x={0} y={0} />
    </Layer>
  )
}
