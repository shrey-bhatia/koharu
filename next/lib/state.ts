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
  translatedText?: string
}

// Load API key from localStorage (browser/Tauri context)
const loadApiKey = (): string | null => {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('google_translate_api_key')
}

export const useEditorStore = create(
  combine(
    {
      image: null,
      tool: 'detection',
      scale: 1,
      textBlocks: [],
      translationApiKey: loadApiKey(),
    } as {
      image: Image | null
      tool: string
      scale: number
      textBlocks: TextBlock[]
      translationApiKey: string | null
    },
    (set) => ({
      setImage: (image: Image | null) => set({ image }),
      setTool: (tool: string) => set({ tool }),
      setScale: (scale: number) => set({ scale }),
      setTextBlocks: (textBlocks: TextBlock[]) => set({ textBlocks }),
      setTranslationApiKey: (key: string | null) => {
        if (typeof window !== 'undefined') {
          if (key) {
            localStorage.setItem('google_translate_api_key', key)
          } else {
            localStorage.removeItem('google_translate_api_key')
          }
        }
        set({ translationApiKey: key })
      },
    })
  )
)
