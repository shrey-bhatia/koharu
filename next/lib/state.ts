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
  manuallyEditedText?: boolean
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

// Load Ollama model name from localStorage
const loadOllamaModel = (): string => {
  if (typeof window === 'undefined') return 'gemma2:2b'
  return localStorage.getItem('ollama_model') || 'gemma2:2b'
}

// Load Ollama system prompt from localStorage
const loadOllamaSystemPrompt = (): string => {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('ollama_system_prompt') || ''
}

// Load translation provider preference
const loadTranslationProvider = (): 'google' | 'deepl-free' | 'deepl-pro' | 'ollama' => {
  if (typeof window === 'undefined') return 'google'
  return (localStorage.getItem('translation_provider') as 'google' | 'deepl-free' | 'deepl-pro' | 'ollama') || 'google'
}

// Load theme preference
const loadTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light'
  return (localStorage.getItem('theme') as 'light' | 'dark') || 'light'
}

// Load OCR engine preference
const loadOcrEngine = (): 'manga-ocr' | 'paddle-ocr' => {
  if (typeof window === 'undefined') return 'manga-ocr'
  return (localStorage.getItem('ocr_engine') as 'manga-ocr' | 'paddle-ocr') || 'manga-ocr'
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

// Load selection sensitivity preference (screen-space pixels for hit target sizing)
const loadSelectionSensitivity = (): number => {
  if (typeof window === 'undefined') return 20
  const stored = localStorage.getItem('selection_sensitivity')
  const parsed = stored ? Number.parseFloat(stored) : NaN
  if (!Number.isFinite(parsed)) return 20
  return Math.min(Math.max(parsed, 10), 40)
}

type SidebarPersistenceState = {
  sidebarWidth: number
  lastExpandedSidebarWidth: number
  isSidebarCollapsed: boolean
}

const DEFAULT_SIDEBAR_STATE: SidebarPersistenceState = {
  sidebarWidth: 288,
  lastExpandedSidebarWidth: 288,
  isSidebarCollapsed: false,
}

const SIDEBAR_STATE_STORAGE_KEY = 'sidebar_state'

const loadSidebarState = (): SidebarPersistenceState => {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_STATE

  try {
    const raw = localStorage.getItem(SIDEBAR_STATE_STORAGE_KEY)
    if (!raw) return DEFAULT_SIDEBAR_STATE

    const parsed = JSON.parse(raw) as Partial<SidebarPersistenceState> | null
    const sidebarWidth = Number(parsed?.sidebarWidth)
    const lastExpandedSidebarWidth = Number(parsed?.lastExpandedSidebarWidth)
    const isSidebarCollapsed = Boolean(parsed?.isSidebarCollapsed)

    return {
      sidebarWidth: Number.isFinite(sidebarWidth) ? sidebarWidth : DEFAULT_SIDEBAR_STATE.sidebarWidth,
      lastExpandedSidebarWidth: Number.isFinite(lastExpandedSidebarWidth)
        ? lastExpandedSidebarWidth
        : DEFAULT_SIDEBAR_STATE.lastExpandedSidebarWidth,
      isSidebarCollapsed,
    }
  } catch (error) {
    console.warn('Failed to load sidebar state:', error)
    return DEFAULT_SIDEBAR_STATE
  }
}

const persistSidebarState = (state: SidebarPersistenceState) => {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(SIDEBAR_STATE_STORAGE_KEY, JSON.stringify(state))
  } catch (error) {
    console.warn('Failed to persist sidebar state:', error)
  }
}

const initialSidebarState = loadSidebarState()

export const useEditorStore = create(
  combine(
    {
      image: null,
      tool: 'detection',
      scale: 1,
      textBlocks: [],
      translationApiKey: loadGoogleApiKey(),
      deeplApiKey: loadDeeplApiKey(),
      ollamaModel: loadOllamaModel(),
      ollamaSystemPrompt: loadOllamaSystemPrompt(),
  translationProvider: loadTranslationProvider(),
  segmentationMask: null,
  segmentationMaskBitmap: null,
  showSegmentationMask: false,
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
      fontSizeStep: 2,
      availableOcrModels: ['manga-ocr', 'paddle-ocr'],
      ocrEngine: loadOcrEngine(),
      selectionSensitivity: loadSelectionSensitivity(),
      sidebarWidth: initialSidebarState.sidebarWidth,
      lastExpandedSidebarWidth: initialSidebarState.lastExpandedSidebarWidth,
      isSidebarCollapsed: initialSidebarState.isSidebarCollapsed,
    } as {
      image: Image | null
      tool: string
      scale: number
      textBlocks: TextBlock[]
      translationApiKey: string | null
      deeplApiKey: string | null
      ollamaModel: string
      ollamaSystemPrompt: string
      translationProvider: 'google' | 'deepl-free' | 'deepl-pro' | 'ollama'
  segmentationMask: number[] | null
  segmentationMaskBitmap: ImageBitmap | null
  showSegmentationMask: boolean
      inpaintedImage: Image | null
      theme: 'light' | 'dark'
      renderMethod: 'rectangle' | 'lama' | 'newlama'
      selectedBlockIndex: number | null
      gpuPreference: 'cuda' | 'directml' | 'cpu'
      currentStage: 'original' | 'textless' | 'rectangles' | 'final'
      availableOcrModels: string[]
      ocrEngine: 'manga-ocr' | 'paddle-ocr'
      pipelineStages: {
        original: Image | null
        textless: Image | null
        withRectangles: Image | null
        final: Image | null
      }
      inpaintingConfig: InpaintingConfig
      inpaintingPreset: 'fast' | 'balanced' | 'quality' | 'custom'
      defaultFont: string
      fontSizeStep: number
      selectionSensitivity: number
      sidebarWidth: number
      lastExpandedSidebarWidth: number
      isSidebarCollapsed: boolean
    },
    (set) => ({
      setImage: (image: Image | null) => set((state) => {
        if (state.segmentationMaskBitmap) {
          try {
            state.segmentationMaskBitmap.close()
          } catch (error) {
            console.warn('Failed to release segmentation mask bitmap:', error)
          }
        }

        return {
          image,
          currentStage: 'original',
          pipelineStages: {
            original: null,
            textless: null,
            withRectangles: null,
            final: null,
          },
          textBlocks: [],
          segmentationMask: null,
          segmentationMaskBitmap: null,
          inpaintedImage: null,
          selectedBlockIndex: null,
          showSegmentationMask: false,
        }
      }),
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
      setTranslationProvider: (provider: 'google' | 'deepl-free' | 'deepl-pro' | 'ollama') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('translation_provider', provider)
        }
        set({ translationProvider: provider })
      },
      setOllamaModel: (model: string) => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('ollama_model', model)
        }
        set({ ollamaModel: model })
      },
      setOllamaSystemPrompt: (prompt: string) => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('ollama_system_prompt', prompt)
        }
        set({ ollamaSystemPrompt: prompt })
      },
      setSegmentationMask: (mask: number[] | null) => set({ segmentationMask: mask }),
      setSegmentationMaskBitmap: (bitmap: ImageBitmap | null) =>
        set((state) => {
          if (state.segmentationMaskBitmap && state.segmentationMaskBitmap !== bitmap) {
            try {
              state.segmentationMaskBitmap.close()
            } catch (error) {
              console.warn('Failed to release segmentation mask bitmap:', error)
            }
          }
          return { segmentationMaskBitmap: bitmap }
        }),
      setShowSegmentationMask: (show: boolean) => set({ showSegmentationMask: show }),
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
      setOcrEngine: (engine: 'manga-ocr' | 'paddle-ocr') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('ocr_engine', engine)
        }
        set({ ocrEngine: engine })
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
      setFontSizeStep: (step: number) => set({ fontSizeStep: step }),
      setSelectionSensitivity: (value: number) => {
        const clamped = Math.min(Math.max(value, 10), 40)
        if (typeof window !== 'undefined') {
          localStorage.setItem('selection_sensitivity', clamped.toString())
        }
        set({ selectionSensitivity: clamped })
      },
      setSidebarWidth: (width: number) =>
        set((state) => {
          const sanitizedWidth = Number.isFinite(width) ? width : state.sidebarWidth
          if (typeof window !== 'undefined') {
            persistSidebarState({
              sidebarWidth: sanitizedWidth,
              lastExpandedSidebarWidth: state.lastExpandedSidebarWidth,
              isSidebarCollapsed: state.isSidebarCollapsed,
            })
          }
          return { sidebarWidth: sanitizedWidth }
        }),
      setLastExpandedSidebarWidth: (width: number) =>
        set((state) => {
          const sanitizedWidth = Number.isFinite(width) ? width : state.lastExpandedSidebarWidth
          if (typeof window !== 'undefined') {
            persistSidebarState({
              sidebarWidth: state.sidebarWidth,
              lastExpandedSidebarWidth: sanitizedWidth,
              isSidebarCollapsed: state.isSidebarCollapsed,
            })
          }
          return { lastExpandedSidebarWidth: sanitizedWidth }
        }),
      setIsSidebarCollapsed: (collapsed: boolean) =>
        set((state) => {
          if (typeof window !== 'undefined') {
            persistSidebarState({
              sidebarWidth: state.sidebarWidth,
              lastExpandedSidebarWidth: state.lastExpandedSidebarWidth,
              isSidebarCollapsed: collapsed,
            })
          }
          return { isSidebarCollapsed: collapsed }
        }),
    })
  )
)
