import { create } from 'zustand'
import { basename } from '@tauri-apps/api/path'
import { BatchRunner } from './batch-runner'
import type {
  BatchConfig,
  BatchPage,
  BatchStatus,
  BatchStopReason,
  BatchSummary,
} from './batch-types'
import { INPAINTING_PRESETS } from './state'
import type { InpaintingConfig } from './state'

const cloneInpaintingConfig = (config: InpaintingConfig): InpaintingConfig => ({
  padding: config.padding,
  targetSize: config.targetSize,
  maskThreshold: config.maskThreshold,
  maskErosion: config.maskErosion,
  maskDilation: config.maskDilation,
  featherRadius: config.featherRadius,
  blendingMethod: config.blendingMethod,
  seamThreshold: config.seamThreshold,
  autoSeamFix: config.autoSeamFix,
  batchSize: config.batchSize,
  showDebugOverlays: config.showDebugOverlays,
  exportTriptychs: config.exportTriptychs,
})

const initialConfig = (): BatchConfig => ({
  renderMethod: 'rectangle',
  confidenceThreshold: 0.5,
  nmsThreshold: 0.5,
  translationProvider: 'google',
  translationApiKey: null,
  deeplApiKey: null,
  ollamaModel: 'gemma2:2b',
  ollamaSystemPrompt: '',
  defaultFont: 'Arial',
  inpaintingConfig: cloneInpaintingConfig(INPAINTING_PRESETS.balanced),
})

interface BatchStoreState {
  status: BatchStatus
  pages: BatchPage[]
  outputDir: string | null
  currentIndex: number
  jobId: string | null
  startedAt: number | null
  completedAt: number | null
  summary: BatchSummary | null
  error: string | null
  shouldStop: boolean
  stopReason: BatchStopReason
  config: BatchConfig
  runner: BatchRunner | null
}

interface BatchStoreActions {
  addPages: (paths: string[]) => Promise<void>
  removePage: (id: string) => void
  clearPages: () => void
  setOutputDir: (dir: string | null) => void
  updateConfig: (config: Partial<BatchConfig>) => void
  resetJob: () => void
  startJob: (configOverride?: Partial<BatchConfig>) => Promise<void>
  pauseJob: () => void
  resumeJob: () => Promise<void>
  cancelJob: () => void
  markError: (message: string) => void
  clearError: () => void
  updatePage: (id: string, updates: Partial<BatchPage>) => void
  incrementIndex: () => void
  setCurrentIndex: (index: number) => void
  setStatus: (status: BatchStatus) => void
  completeJob: (summary: BatchSummary) => void
  recordStop: (reason: BatchStopReason) => void
  releaseRunner: () => void
}

export type BatchStore = BatchStoreState & BatchStoreActions

export const useBatchStore = create<BatchStore>((set, get) => ({
  status: 'idle',
  pages: [],
  outputDir: null,
  currentIndex: 0,
  jobId: null,
  startedAt: null,
  completedAt: null,
  summary: null,
  error: null,
  shouldStop: false,
  stopReason: null,
  config: initialConfig(),
  runner: null,

  async addPages(paths) {
    if (!paths.length) return

    const newPages = await Promise.all(
      paths.map(async (path) => ({
        id: crypto.randomUUID(),
        fileName: await basename(path),
        sourcePath: path,
        stage: 'pending' as BatchPage['stage'],
        progress: 0,
        stageTimings: {},
      }))
    )

    set((state) => ({
      pages: [...state.pages, ...newPages],
      status: state.status === 'idle' ? 'ready' : state.status,
    }))
  },

  removePage(id) {
    set((state) => {
      const pages = state.pages.filter((page) => page.id !== id)
      return {
        pages,
        status: pages.length === 0 ? 'idle' : state.status,
        currentIndex: Math.min(state.currentIndex, pages.length),
      }
    })
  },

  clearPages() {
    set({ pages: [], currentIndex: 0, status: 'idle' })
  },

  setOutputDir(dir) {
    set({ outputDir: dir })
  },

  updateConfig(config) {
    set((state) => ({
      config: {
        ...state.config,
        ...config,
        inpaintingConfig: config.inpaintingConfig
          ? cloneInpaintingConfig(config.inpaintingConfig)
          : state.config.inpaintingConfig,
      },
    }))
  },

  resetJob() {
    set({
      status: 'idle',
      pages: [],
      outputDir: null,
      currentIndex: 0,
      jobId: null,
      startedAt: null,
      completedAt: null,
      summary: null,
      error: null,
      shouldStop: false,
      stopReason: null,
      config: initialConfig(),
      runner: null,
    })
  },

  async startJob(configOverride) {
    const state = get()
    if (state.pages.length === 0) {
      set({ error: 'Add at least one image to start batch processing.' })
      return
    }
    if (!state.outputDir) {
      set({ error: 'Select an output directory before starting the batch.' })
      return
    }
    if (state.status === 'running') {
      return
    }

    const nextConfig: BatchConfig = {
      ...state.config,
      ...configOverride,
      inpaintingConfig: configOverride?.inpaintingConfig
        ? cloneInpaintingConfig(configOverride.inpaintingConfig)
        : state.config.inpaintingConfig,
    }

    set((current) => ({
      pages: current.pages.map((page) => ({
        ...page,
        stage: 'pending',
        progress: 0,
        error: undefined,
        warnings: [],
        startedAt: undefined,
        completedAt: undefined,
        outputImagePath: undefined,
        manifestPath: undefined,
        stageTimings: {},
      })),
      currentIndex: 0,
    }))

    const runner = new BatchRunner(get, set)

    set({
      config: nextConfig,
      status: 'running',
      shouldStop: false,
      stopReason: null,
      error: null,
      jobId: state.jobId ?? crypto.randomUUID(),
      startedAt: state.startedAt ?? Date.now(),
      runner,
    })

    void runner.run()
  },

  pauseJob() {
    const state = get()
    if (state.status !== 'running' || !state.runner) return
    set({ shouldStop: true, stopReason: 'pause' })
    state.runner.requestStop('pause')
  },

  async resumeJob() {
    const state = get()
    if (state.status !== 'paused') return

    const runner = new BatchRunner(get, set)
    set({
      status: 'running',
      shouldStop: false,
      stopReason: null,
      runner,
    })

    void runner.run()
  },

  cancelJob() {
    const state = get()
    if ((state.status !== 'running' && state.status !== 'paused') || !state.runner) return
    set({ shouldStop: true, stopReason: 'cancel' })
    state.runner.requestStop('cancel')
  },

  markError(message) {
    set({ error: message })
  },

  clearError() {
    set({ error: null })
  },

  updatePage(id, updates) {
    set((state) => ({
      pages: state.pages.map((page) => (page.id === id ? { ...page, ...updates } : page)),
    }))
  },

  incrementIndex() {
    set((state) => ({ currentIndex: Math.min(state.currentIndex + 1, state.pages.length) }))
  },

  setCurrentIndex(index) {
    set({ currentIndex: index })
  },

  setStatus(status) {
    set({ status })
  },

  completeJob(summary) {
    set({
      status: 'completed',
      completedAt: Date.now(),
      summary,
      shouldStop: false,
      stopReason: null,
      runner: null,
    })
  },

  recordStop(reason) {
    set({
      shouldStop: false,
      stopReason: null,
      status: reason === 'cancel' ? 'cancelled' : 'paused',
      runner: null,
    })
  },

  releaseRunner() {
    set({ runner: null })
  },
}))
