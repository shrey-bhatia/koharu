import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { Image } from './image'

export interface RGB {
  r: number
  g: number
  b: number
}

export interface InpaintingConfig {
  // Core quality parameters
  padding: number              // 15-100px, default: 50
  targetSize: number           // 256/384/512/768/1024, default: 512
  maskThreshold: number        // 20-50, default: 30
  maskErosion: number          // 0-10px, default: 3
  maskDilation: number         // 0-5px, default: 0
  featherRadius: number        // 0-15px, default: 5

  // Blending
  blendingMethod: 'alpha' | 'seamless' | 'auto'
  seamThreshold: number        // 0-1, default: 0.3 (auto mode trigger)

  // Performance
  batchSize: number            // 1-5, default: 1

  // Debug
  showDebugOverlays: boolean
  exportTriptychs: boolean
}

export const INPAINTING_PRESETS: Record<'fast' | 'balanced' | 'quality', InpaintingConfig> = {
  fast: {
    padding: 0,
    targetSize: 512,  // NOTE: LaMa model only supports 512px, this is kept for API compat
    maskThreshold: 30,
    maskErosion: 1,
    maskDilation: 0,
    featherRadius: 3,
    blendingMethod: 'alpha',
    seamThreshold: 0.3,
    batchSize: 1,
    showDebugOverlays: false,
    exportTriptychs: false,
  },
  balanced: {
    padding: 0,
    targetSize: 512,  // NOTE: LaMa model only supports 512px
    maskThreshold: 30,
    maskErosion: 2,
    maskDilation: 0,
    featherRadius: 5,
    blendingMethod: 'auto',
    seamThreshold: 0.3,
    batchSize: 1,
    showDebugOverlays: false,
    exportTriptychs: false,
  },
  quality: {
    padding: 0,
    targetSize: 512,  // NOTE: LaMa model only supports 512px
    maskThreshold: 30,
    maskErosion: 3,
    maskDilation: 1,
    featherRadius: 7,
    blendingMethod: 'seamless',
    seamThreshold: 0.2,
    batchSize: 1,
    showDebugOverlays: false,
    exportTriptychs: false,
  },
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
      inpaintingConfig: INPAINTING_PRESETS.balanced,
      inpaintingPreset: 'balanced' as 'fast' | 'balanced' | 'quality' | 'custom',
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
      inpaintingConfig: InpaintingConfig
      inpaintingPreset: 'fast' | 'balanced' | 'quality' | 'custom'
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
      setInpaintingPreset: (preset: 'fast' | 'balanced' | 'quality') =>
        set({
          inpaintingConfig: INPAINTING_PRESETS[preset],
          inpaintingPreset: preset,
        }),
      setInpaintingConfig: (config: Partial<InpaintingConfig>) =>
        set((state) => ({
          inpaintingConfig: { ...state.inpaintingConfig, ...config },
          inpaintingPreset: 'custom', // Mark as custom when user tweaks
        })),
    })
  )
)
