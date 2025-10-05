import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { Image } from './image'

export type PipelineStage = 'original' | 'textless' | 'rectangles' | 'final'

export type StageStatus = {
  stage: PipelineStage
  image: Image | null
  isVisible: boolean
  isAvailable: boolean
  isSelectable: boolean
}

type PipelineStages = Record<PipelineStage, Image | null>

export type StageSnapshot = {
  renderMethod: 'rectangle' | 'lama' | 'newlama'
  pipelineStages: PipelineStages
  image: Image | null
}

const stageToImage = (state: StageSnapshot, stage: PipelineStage): Image | null => {
  switch (stage) {
    case 'original':
      return state.pipelineStages.original ?? state.image
    case 'textless':
      return state.pipelineStages.textless
    case 'rectangles':
      return state.pipelineStages.rectangles
    case 'final':
      return state.pipelineStages.final
    default:
      return null
  }
}

export const deriveStageStatus = (state: StageSnapshot, stage: PipelineStage): StageStatus => {
  const image = stageToImage(state, stage)
  const isVisible = stage !== 'rectangles' || state.renderMethod === 'rectangle'
  const isAvailable = stage === 'original' ? !!(state.pipelineStages.original ?? state.image) : !!image
  const isSelectable = isVisible && (stage === 'original' ? isAvailable : !!image)

  return {
    stage,
    image,
    isVisible,
    isAvailable,
    isSelectable,
  }
}

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
      ollamaModel: loadOllamaModel(),
      ollamaSystemPrompt: loadOllamaSystemPrompt(),
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
        rectangles: null,
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
      ollamaModel: string
      ollamaSystemPrompt: string
      translationProvider: 'google' | 'deepl-free' | 'deepl-pro' | 'ollama'
      segmentationMask: number[] | null
      inpaintedImage: Image | null
      theme: 'light' | 'dark'
      renderMethod: 'rectangle' | 'lama' | 'newlama'
      selectedBlockIndex: number | null
      gpuPreference: 'cuda' | 'directml' | 'cpu'
      currentStage: 'original' | 'textless' | 'rectangles' | 'final'
      pipelineStages: PipelineStages
      inpaintingConfig: InpaintingConfig
      inpaintingPreset: 'fast' | 'balanced' | 'quality' | 'custom'
      defaultFont: string
    },
    (set) => ({
      loadImageSession: (image: Image | null) =>
        set(() => {
          const nextPipeline: PipelineStages = {
            original: image,
            textless: null,
            rectangles: null,
            final: null,
          }

          if (!image) {
            return {
              image: null,
              pipelineStages: nextPipeline,
              textBlocks: [],
              segmentationMask: null,
              inpaintedImage: null,
              selectedBlockIndex: null,
              currentStage: 'original' as PipelineStage,
              tool: 'detection',
              scale: 1,
            }
          }

          return {
            image,
            pipelineStages: nextPipeline,
            textBlocks: [],
            segmentationMask: null,
            inpaintedImage: null,
            selectedBlockIndex: null,
            currentStage: 'original' as PipelineStage,
            tool: 'detection',
            scale: 1,
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
        set((state) => {
          const updates: Partial<typeof state> = { renderMethod: method }

          if (method !== 'rectangle') {
            const fallbackStage: PipelineStage = state.pipelineStages.textless ? 'textless' : 'original'
            if (state.currentStage === 'rectangles') {
              updates.currentStage = fallbackStage
            }
            if (state.pipelineStages.rectangles) {
              updates.pipelineStages = {
                ...state.pipelineStages,
                rectangles: null,
              }
            }
          }

          return updates
        })
      },
      setSelectedBlockIndex: (index: number | null) => set({ selectedBlockIndex: index }),
      setGpuPreference: (pref: 'cuda' | 'directml' | 'cpu') => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('gpu_preference', pref)
        }
        set({ gpuPreference: pref })
      },
      setCurrentStage: (stage: PipelineStage) =>
        set((state) => {
          const status = deriveStageStatus(state, stage)
          if (!status.isSelectable) {
            return {}
          }
          return { currentStage: stage }
        }),
      setPipelineStage: (stage: PipelineStage, image: Image | null) =>
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

export type EditorState = ReturnType<typeof useEditorStore.getState>

type StagefulState = Pick<EditorState, 'renderMethod' | 'pipelineStages' | 'currentStage' | 'image'>

const deriveStageOrder = (
  state: StagefulState,
  stageOverride?: PipelineStage
): PipelineStage[] => {
  const primaryStage = stageOverride ?? state.currentStage
  const order: PipelineStage[] = []
  const push = (value: PipelineStage) => {
    if (!order.includes(value)) {
      order.push(value)
    }
  }

  push(primaryStage)
  if (state.renderMethod === 'rectangle') {
    push('final')
    push('rectangles')
    push('textless')
  } else {
    push('final')
    push('textless')
  }
  push('original')

  return order
}

export const deriveActiveBaseImage = (
  state: StagefulState,
  stageOverride?: PipelineStage
): Image | null => {
  const order = deriveStageOrder(state, stageOverride)

  for (const candidate of order) {
    const status = deriveStageStatus(state, candidate)
    if (!status.isVisible) continue
    if (status.image) return status.image
  }

  return state.image
}

export const getStageStatus = (stage: PipelineStage): StageStatus =>
  deriveStageStatus(useEditorStore.getState(), stage)

export const getActiveBaseImage = (stageOverride?: PipelineStage): Image | null =>
  deriveActiveBaseImage(useEditorStore.getState(), stageOverride)

export const getAllStageStatuses = (): StageStatus[] =>
  (['original', 'textless', 'rectangles', 'final'] as PipelineStage[]).map((stage) =>
    getStageStatus(stage)
  )

export const selectActiveBaseImage = (stageOverride?: PipelineStage) =>
  (state: EditorState) => deriveActiveBaseImage(state, stageOverride)

export const selectStageStatuses = (state: EditorState): StageStatus[] =>
  (['original', 'textless', 'rectangles', 'final'] as PipelineStage[])
    .map((stage) => deriveStageStatus(state, stage))
    .filter((status) => status.isVisible)
