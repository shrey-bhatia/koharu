import type { InpaintingConfig } from './state'

export type BatchPageStage =
  | 'pending'
  | 'loading'
  | 'detection'
  | 'ocr'
  | 'translation'
  | 'inpainting'
  | 'coloring'
  | 'render'
  | 'saving'
  | 'done'
  | 'failed'

export type BatchStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error'

export type BatchStopReason = 'pause' | 'cancel' | null

export interface BatchPage {
  id: string
  fileName: string
  sourcePath: string
  stage: BatchPageStage
  progress: number
  error?: string
  warnings?: string[]
  startedAt?: number
  completedAt?: number
  outputImagePath?: string
  manifestPath?: string
  stageTimings: Partial<Record<BatchPageStage, number>>
}

export interface BatchSummary {
  processedPages: number
  failedPages: number
  durationMs: number
}

export interface BatchConfig {
  renderMethod: 'rectangle' | 'lama' | 'newlama'
  confidenceThreshold: number
  nmsThreshold: number
  translationProvider: 'google' | 'deepl-free' | 'deepl-pro' | 'ollama'
  translationApiKey: string | null
  deeplApiKey: string | null
  ollamaModel: string
  ollamaSystemPrompt: string
  defaultFont: string
  inpaintingConfig: InpaintingConfig
}
