import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { Image } from './image'

export interface RGB {
  r: number
  g: number
  b: number
}

export type TextBlock = {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
  confidence: number
  class: number
  text?: string
  translatedText?: string
  // Rendering fields (Option 1: Rectangle fill)
  backgroundColor?: RGB
  textColor?: RGB
  fontSize?: number
  fontFamily?: string
  letterSpacing?: number // in pixels
  fontWeight?: number | 'normal' | 'bold' // 100-900 or keywords
  fontStretch?: 'normal' | 'condensed' | 'expanded' // font-stretch values
  // Manual overrides
  manualBgColor?: RGB
  manualTextColor?: RGB
  // OCR tracking
  ocrStale?: boolean // true if box moved since last OCR
}

// Load API key from localStorage (browser/Tauri context)
const loadApiKey = (): string | null => {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('google_translate_api_key')
}

// Load theme preference
const loadTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light'
  return (localStorage.getItem('theme') as 'light' | 'dark') || 'light'
}

// Load rendering method preference
const loadRenderMethod = (): 'rectangle' | 'lama' | 'newlama' => {
  if (typeof window === 'undefined') return 'rectangle'
  return (localStorage.getItem('render_method') as 'rectangle' | 'lama' | 'newlama') || 'rectangle'
}

// Load GPU preference
const loadGpuPreference = (): 'cuda' | 'directml' | 'cpu' => {
  if (typeof window === 'undefined') return 'cuda'
  return (localStorage.getItem('gpu_preference') as 'cuda' | 'directml' | 'cpu') || 'cuda'
}

export const useEditorStore = create(
  combine(
    {
      image: null,
      tool: 'detection',
      scale: 1,
      textBlocks: [],
      translationApiKey: loadApiKey(),
      segmentationMask: null,
      inpaintedImage: null,
      theme: loadTheme(),
      renderMethod: loadRenderMethod(),
      selectedBlockIndex: null,
      gpuPreference: loadGpuPreference(),
      currentStage: 'original',
      pipelineStages: {
        original: null,
        textless: null,
        withRectangles: null,
        final: null,
      },
    } as {
      image: Image | null
      tool: string
      scale: number
      textBlocks: TextBlock[]
      translationApiKey: string | null
      segmentationMask: number[] | null
      inpaintedImage: Image | null
      theme: 'light' | 'dark'
      renderMethod: 'rectangle' | 'lama' | 'newlama'
      selectedBlockIndex: number | null
      gpuPreference: 'cuda' | 'directml' | 'cpu'
      currentStage: 'original' | 'textless' | 'rectangles' | 'final'
      pipelineStages: {
        original: Image | null
        textless: Image | null
        withRectangles: Image | null
        final: Image | null
      }
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
      setSegmentationMask: (mask: number[] | null) => set({ segmentationMask: mask }),
      setInpaintedImage: (image: Image | null) => set({ inpaintedImage: image }),
      setTheme: (theme: 'light' | 'dark') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('theme', theme)
          document.documentElement.classList.toggle('dark', theme === 'dark')
        }
        set({ theme })
      },
      setRenderMethod: (method: 'rectangle' | 'lama' | 'newlama') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('render_method', method)
        }
        set({ renderMethod: method })
      },
      setSelectedBlockIndex: (index: number | null) => set({ selectedBlockIndex: index }),
      setGpuPreference: (pref: 'cuda' | 'directml' | 'cpu') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('gpu_preference', pref)
        }
        set({ gpuPreference: pref })
      },
      setCurrentStage: (stage: 'original' | 'textless' | 'rectangles' | 'final') => set({ currentStage: stage }),
      setPipelineStage: (stage: 'original' | 'textless' | 'withRectangles' | 'final', image: Image | null) =>
        set((state) => ({
          pipelineStages: { ...state.pipelineStages, [stage]: image },
        })),
    })
  )
)
