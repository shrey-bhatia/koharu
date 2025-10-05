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
  seamThreshold: number        // Edge variance threshold (0-100, default: 30)
  autoSeamFix: boolean         // Enable automatic seam fix for high-variance edges

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
    seamThreshold: 30,
    autoSeamFix: false,
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
    seamThreshold: 30,
    autoSeamFix: true,
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
    seamThreshold: 25,
    autoSeamFix: true,
    batchSize: 1,
    showDebugOverlays: false,
    exportTriptychs: false,
  },
}

export interface ColorPalette {
  color: RGB
  percentage: number
}

export interface MaskStats {
  area: number
  centroid: [number, number]
  orientationDeg: number
  eccentricity: number
}

export interface AppearanceMetadata {
  sourceTextColor: RGB
  sourceBackgroundColor: RGB
  sourceOutlineColor?: RGB
  outlineWidthPx?: number
  textColorPalette?: ColorPalette[]
  backgroundColorPalette?: ColorPalette[]
  confidence: number // 0-1, overall confidence in color extraction
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
  lineHeight?: number // line height multiplier (1.0 = tight, 1.5 = relaxed)
  fontWeight?: number | 'normal' | 'bold' // 100-900 or keywords
  fontStretch?: 'normal' | 'condensed' | 'expanded' // font-stretch values
  // Manual overrides
  manualBgColor?: RGB
  manualTextColor?: RGB
  // OCR tracking
  ocrStale?: boolean // true if box moved since last OCR
  // Appearance analysis (immutable, derived from source)
  appearance?: AppearanceMetadata
  maskStats?: MaskStats
  appearanceAnalyzed?: boolean
}

// Load Google API key from localStorage (browser/Tauri context)
const loadGoogleApiKey = (): string | null => {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('google_translate_api_key')
}

// Load DeepL API key from localStorage
const loadDeeplApiKey = (): string | null => {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('deepl_translate_api_key')
}

// Load translation provider preference
const loadTranslationProvider = (): 'google' | 'deepl-free' | 'deepl-pro' => {
  if (typeof window === 'undefined') return 'google'
  return (localStorage.getItem('translation_provider') as 'google' | 'deepl-free' | 'deepl-pro') || 'google'
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

// Load default font
const loadDefaultFont = (): string => {
  if (typeof window === 'undefined') return 'Arial'
  return localStorage.getItem('default_font') || 'Arial'
}

export const useEditorStore = create(
  combine(
    {
      image: null,
      tool: 'detection',
      scale: 1,
      textBlocks: [],
      translationApiKey: loadGoogleApiKey(),
      deeplApiKey: loadDeeplApiKey(),
      translationProvider: loadTranslationProvider(),
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
      defaultFont: loadDefaultFont(),
    } as {
      image: Image | null
      tool: string
      scale: number
      textBlocks: TextBlock[]
      translationApiKey: string | null
      deeplApiKey: string | null
      translationProvider: 'google' | 'deepl-free' | 'deepl-pro'
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
      defaultFont: string
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
      setDeeplApiKey: (key: string | null) => {
        if (typeof window !== 'undefined') {
          if (key) {
            localStorage.setItem('deepl_translate_api_key', key)
          } else {
            localStorage.removeItem('deepl_translate_api_key')
          }
        }
        set({ deeplApiKey: key })
      },
      setTranslationProvider: (provider: 'google' | 'deepl-free' | 'deepl-pro') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('translation_provider', provider)
        }
        set({ translationProvider: provider })
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
      setDefaultFont: (font: string) => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('default_font', font)
        }
        set({ defaultFont: font })
      },
    })
  )
)
