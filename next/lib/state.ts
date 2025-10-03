import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { Image } from './image'

export type TextBlock = {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
  confidence: number
  class: number
  text?: string
}

export const useEditorStore = create(
  combine(
    {
      image: null,
      tool: 'detection',
      scale: 1,
      textBlocks: [],
    } as {
      image: Image | null
      tool: string
      scale: number
      textBlocks: TextBlock[]
    },
    (set) => ({
      setImage: (image: Image | null) => set({ image }),
      setTool: (tool: string) => set({ tool }),
      setScale: (scale: number) => set({ scale }),
      setTextBlocks: (textBlocks: TextBlock[]) => set({ textBlocks }),
    })
  )
)
