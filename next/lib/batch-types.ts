import type { InpaintingConfig } from './state'

export type BatchLogLevel = 'info' | 'warning' | 'error'

export interface BatchPageLogEntry {
  id: string
  timestamp: number
  level: BatchLogLevel
  message: string
  stage?: BatchPageStage
}

export const createBatchLogEntry = (
  message: string,
  level: BatchLogLevel = 'info',
  stage?: BatchPageStage
): BatchPageLogEntry => ({
  id:
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  timestamp: Date.now(),
  level,
  message,
  stage,
})

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
  logs: BatchPageLogEntry[]
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
