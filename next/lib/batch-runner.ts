import { readBinaryFile, writeBinaryFile, writeTextFile, createDir } from '@tauri-apps/api/fs'
import { basename, extname, join } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'
import type { BatchStore } from './batch-state'
import { createBatchLogEntry } from './batch-types'
import type {
  BatchConfig,
  BatchPage,
  BatchPageStage,
  BatchSummary,
  BatchLogLevel,
  BatchStopReason,
} from './batch-types'
import type { TextBlock } from './state'
import { analyzeTextAppearance } from '@/utils/appearance-analysis'
import { crop, imageBitmapToArrayBuffer, maskToArrayBuffer } from '@/utils/image'
import { translate, TranslationAPIError } from '@/utils/translation'
import { extractBackgroundColor } from '@/utils/color-extraction'
import { ensureReadableContrast } from '@/utils/wcag-contrast'
import { calculateOptimalFontSize } from '@/utils/font-sizing'
import { calculateImprovedFontSize } from '@/utils/improved-font-sizing'
import { compositeMaskedRegion } from '@/utils/alpha-compositing'
import { createImageFromBlob, createImageFromBuffer, type Image } from './image'
import type { InpaintingConfig } from './state'

interface DetectionResult {
  bboxes: TextBlock[]
  segment?: number[]
}

interface RenderArtifacts {
  finalBuffer: ArrayBuffer
  rectanglesBuffer: ArrayBuffer | null
}

export class BatchRunner {
  private stopRequested = false
  private stopReason: BatchStopReason = null

  constructor(
    private readonly getState: () => BatchStore,
    private readonly setState: (partial: (state: BatchStore) => Partial<BatchStore> | void) => void
  ) {}

  private log(pageId: string, message: string, level: BatchLogLevel = 'info', stage?: BatchPageStage) {
    const store = this.getState()
    if (typeof store.appendLog === 'function') {
      store.appendLog(pageId, createBatchLogEntry(message, level, stage))
    }
  }

  private describeStage(stage: BatchPageStage): string {
    switch (stage) {
      case 'loading':
        return 'Loading source image'
      case 'detection':
        return 'Running text detection'
      case 'ocr':
        return 'Performing OCR'
      case 'translation':
        return 'Translating text'
      case 'inpainting':
        return 'Applying inpainting'
      case 'coloring':
        return 'Analyzing appearance'
      case 'render':
        return 'Rendering final image'
      case 'saving':
        return 'Saving outputs'
      case 'pending':
        return 'Pending'
      case 'done':
        return 'Completed'
      case 'failed':
        return 'Failed'
      default:
        return stage
    }
  }

  private formatDuration(durationMs: number): string {
    if (durationMs >= 1000) {
      const seconds = durationMs / 1000
      return seconds >= 10 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(2)}s`
    }
    return `${Math.round(durationMs)}ms`
  }

  requestStop(reason: BatchStopReason) {
    this.stopRequested = true
    this.stopReason = reason
  }

  async run(): Promise<void> {
    try {
      const state = this.getState()
      for (let index = state.currentIndex; index < state.pages.length; index++) {
        if (this.shouldAbort()) break
        await this.processPage(index)

        const pageState = this.getState().pages[index]
        if (!pageState) break

        const pageCompleted = pageState.stage === 'done' || pageState.stage === 'failed'
        if (pageCompleted) {
          this.setState(() => ({ currentIndex: index + 1 }))
        }

        if (this.shouldAbort() && !pageCompleted) {
          break
        }
      }

      if (this.shouldAbort()) {
        this.finalizeStop()
        return
      }

      this.finishJob()
    } catch (error) {
      console.error('[BatchRunner] Job failed', error)
      this.setState(() => ({
        status: 'error',
        error: error instanceof Error ? error.message : 'Batch processing failed',
        runner: null,
      }))
    }
  }

  private shouldAbort(): boolean {
    const state = this.getState()
    return this.stopRequested || state.shouldStop
  }

  private finalizeStop() {
    const reason = this.stopReason || this.getState().stopReason
    this.setState(() => ({
      shouldStop: false,
      stopReason: null,
      status: reason === 'cancel' ? 'cancelled' : 'paused',
      runner: null,
    }))
    this.stopRequested = false
    this.stopReason = null
  }

  private finishJob() {
    const state = this.getState()
    const processedPages = state.pages.filter((page) => page.stage === 'done').length
    const failedPages = state.pages.filter((page) => page.stage === 'failed').length
    const durationMs = state.startedAt ? Date.now() - state.startedAt : 0
    const summary: BatchSummary = { processedPages, failedPages, durationMs }

    this.setState(() => ({
      status: 'completed',
      completedAt: Date.now(),
      summary,
      shouldStop: false,
      stopReason: null,
      runner: null,
    }))
    this.stopRequested = false
    this.stopReason = null
  }

  private buildStageSequence(renderMethod: BatchConfig['renderMethod']): BatchPageStage[] {
    const stages: BatchPageStage[] = ['loading', 'detection', 'ocr', 'translation']
    if (renderMethod !== 'rectangle') {
      stages.push('inpainting')
    }
    stages.push('coloring', 'render', 'saving')
    return stages
  }

  private updatePage(pageId: string, updates: Partial<BatchPage>) {
    this.setState((state) => ({
      pages: state.pages.map((page) => (page.id === pageId ? { ...page, ...updates } : page)),
    }))
  }

  private updateStageProgress(pageId: string, stageOrder: BatchPageStage[], stage: BatchPageStage) {
    const idx = stageOrder.findIndex((s) => s === stage)
    if (idx === -1) return
    const progress = Math.min((idx + 1) / stageOrder.length, 0.999)
    this.updatePage(pageId, { progress })
  }

  private appendWarning(pageId: string, warning: string, stage?: BatchPageStage) {
    this.setState((state) => ({
      pages: state.pages.map((page) =>
        page.id === pageId
          ? {
              ...page,
              warnings: [...(page.warnings ?? []), warning],
            }
          : page
      ),
    }))
    this.log(pageId, warning, 'warning', stage)
  }

  private recordTiming(pageId: string, stage: BatchPageStage, durationMs: number) {
    this.setState((state) => ({
      pages: state.pages.map((page) =>
        page.id === pageId
          ? {
              ...page,
              stageTimings: {
                ...page.stageTimings,
                [stage]: (page.stageTimings[stage] ?? 0) + durationMs,
              },
            }
          : page
      ),
    }))
  }

  private async processPage(index: number): Promise<void> {
    const state = this.getState()
    const page = state.pages[index]
    const config = state.config
    const stageOrder = this.buildStageSequence(config.renderMethod)
    let textBlocks: TextBlock[] = []
    let segmentationMask: number[] | null = null
    let textlessImage: Image | null = null

    this.log(page.id, `Starting processing for ${page.fileName}`)
    this.updatePage(page.id, {
      stage: 'loading',
      progress: 0,
      error: undefined,
      warnings: [],
      startedAt: Date.now(),
    })

    try {
      const { image, imageBuffer } = await this.stageWrapper(page.id, 'loading', async () => {
        const raw = await readBinaryFile(page.sourcePath)
        const arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
        const blob = new Blob([raw])
        const image = await createImageFromBlob(blob)
        return { image, imageBuffer: arrayBuffer }
      })
      this.updateStageProgress(page.id, stageOrder, 'loading')
      if (this.shouldAbort()) return

      const detection = await this.stageWrapper(page.id, 'detection', async () =>
        this.runDetection(image, imageBuffer, config)
      )
      textBlocks = detection.textBlocks
      segmentationMask = detection.segmentationMask
      if (textBlocks.length === 0) {
        this.appendWarning(page.id, 'No text regions were detected in this page.', 'detection')
      }
      this.updateStageProgress(page.id, stageOrder, 'detection')
      if (this.shouldAbort()) return

      textBlocks = await this.stageWrapper(page.id, 'ocr', async () =>
        this.runOCR(image, textBlocks)
      )
      this.updateStageProgress(page.id, stageOrder, 'ocr')
      if (this.shouldAbort()) return

      textBlocks = await this.stageWrapper(page.id, 'translation', async () =>
        this.runTranslation(textBlocks, config)
      )
      this.updateStageProgress(page.id, stageOrder, 'translation')
      if (this.shouldAbort()) return

      if (config.renderMethod !== 'rectangle') {
        textlessImage = await this.stageWrapper(page.id, 'inpainting', async () => {
          if (!segmentationMask) {
            throw new Error('Segmentation mask missing; run detection again or switch to rectangle mode.')
          }
          return this.runInpainting(image, segmentationMask, textBlocks, config.inpaintingConfig)
        })
        this.updateStageProgress(page.id, stageOrder, 'inpainting')
        if (this.shouldAbort()) return
      }

      textBlocks = await this.stageWrapper(page.id, 'coloring', async () =>
        this.prepareBlocksForRendering(image, textBlocks, config.defaultFont)
      )
      this.updateStageProgress(page.id, stageOrder, 'coloring')
      if (this.shouldAbort()) return

      const artifacts = await this.stageWrapper(page.id, 'render', async () =>
        this.renderFinalImage({
          image,
          textlessImage,
          textBlocks,
          renderMethod: config.renderMethod,
        })
      )
      this.updateStageProgress(page.id, stageOrder, 'render')
      if (this.shouldAbort()) return

      const outputs = await this.stageWrapper(page.id, 'saving', async () =>
        this.saveOutputs(index, page, artifacts, textBlocks, config)
      )
      this.updateStageProgress(page.id, stageOrder, 'saving')
      if (this.shouldAbort()) return

      this.log(
        page.id,
        `Saved outputs to ${outputs.outputImagePath}${
          outputs.manifestPath ? ` (manifest: ${outputs.manifestPath})` : ''
        }`,
        'info',
        'saving'
      )
      this.updatePage(page.id, {
        stage: 'done',
        progress: 1,
        completedAt: Date.now(),
        outputImagePath: outputs.outputImagePath,
        manifestPath: outputs.manifestPath,
      })
      this.log(page.id, 'Page processed successfully')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[BatchRunner] Page ${page.fileName} failed`, error)
      this.updatePage(page.id, {
        stage: 'failed',
        progress: 1,
        error: message,
        completedAt: Date.now(),
      })
      this.log(page.id, `Page failed: ${message}`, 'error')
    }
  }

  private async stageWrapper<T>(
    pageId: string,
    stage: BatchPageStage,
    handler: () => Promise<T>
  ): Promise<T> {
    const start = performance.now()
    this.updatePage(pageId, { stage })
    const label = this.describeStage(stage)
    this.log(pageId, `${label} started`, 'info', stage)
    try {
      const result = await handler()
      const duration = performance.now() - start
      this.recordTiming(pageId, stage, duration)
      this.log(pageId, `${label} completed in ${this.formatDuration(duration)}`, 'info', stage)
      return result
    } catch (error) {
      const duration = performance.now() - start
      this.recordTiming(pageId, stage, duration)
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.log(pageId, `${label} failed: ${message}`, 'error', stage)
      throw error
    }
  }

  private async runDetection(
    image: Image,
    imageBuffer: ArrayBuffer,
    config: BatchConfig
  ): Promise<{ textBlocks: TextBlock[]; segmentationMask: number[] | null }> {
    const result = await invoke<DetectionResult>('detection', {
      image: imageBuffer,
      confidenceThreshold: config.confidenceThreshold,
      nmsThreshold: config.nmsThreshold,
    })

    let textBlocks = result?.bboxes ?? []
    const segmentationMask = result?.segment ?? null

    if (segmentationMask && textBlocks.length > 0) {
      textBlocks = await analyzeTextAppearance(image.bitmap, segmentationMask, textBlocks)
    }

    return { textBlocks, segmentationMask }
  }

  private async runOCR(image: Image, blocks: TextBlock[]): Promise<TextBlock[]> {
    const updatedBlocks: TextBlock[] = []

    for (const block of blocks) {
      const width = Math.max(1, Math.floor(block.xmax - block.xmin))
      const height = Math.max(1, Math.floor(block.ymax - block.ymin))
      const croppedBitmap = await crop(
        image.bitmap,
        Math.floor(block.xmin),
        Math.floor(block.ymin),
        width,
        height
      )
      const buffer = await imageBitmapToArrayBuffer(croppedBitmap)
      const response = await invoke<string>('ocr', {
        image: Array.from(new Uint8Array(buffer)),
      })
      updatedBlocks.push({ ...block, text: response, ocrStale: false })
    }

    return updatedBlocks
  }

  private async runTranslation(blocks: TextBlock[], config: BatchConfig): Promise<TextBlock[]> {
    const apiKey = this.resolveTranslationKey(config)
    const updated: TextBlock[] = []

    if (config.translationProvider !== 'ollama') {
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error('Translation API key is missing. Update batch settings and try again.')
      }
    }

    for (const block of blocks) {
      if (!block.text || block.text.trim().length === 0) {
        updated.push(block)
        continue
      }

      try {
        const translated = await translate(
          block.text,
          config.translationProvider,
          apiKey,
          'ja',
          'en',
          config.ollamaModel,
          config.ollamaSystemPrompt
        )
        updated.push({ ...block, translatedText: translated })
      } catch (error) {
        if (error instanceof TranslationAPIError) {
          if (error.code === 403 || error.code === 401) {
            throw new Error('Invalid translation API key')
          }
          if (error.code === 429) {
            throw new Error('Translation rate limit exceeded. Try again later.')
          }
        }
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    return updated
  }

  private resolveTranslationKey(config: BatchConfig): string | null {
    if (config.translationProvider === 'google') return config.translationApiKey
    if (config.translationProvider === 'ollama') return 'not-required'
    return config.deeplApiKey
  }

  private async runInpainting(
    image: Image,
    segmentationMask: number[],
    blocks: TextBlock[],
    inpaintConfig: InpaintingConfig
  ): Promise<Image> {
    const imageBuffer = await imageBitmapToArrayBuffer(image.bitmap)
    const maskBuffer = await maskToArrayBuffer(segmentationMask)
    const canvas = new OffscreenCanvas(image.bitmap.width, image.bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to obtain canvas context for inpainting')

    ctx.drawImage(image.bitmap, 0, 0)

    for (const block of blocks) {
      const result = await invoke<{
        image: number[]
        x: number
        y: number
        width: number
        height: number
      }>('inpaint_region', {
        image: Array.from(new Uint8Array(imageBuffer)),
        mask: Array.from(new Uint8Array(maskBuffer)),
        bbox: {
          xmin: block.xmin,
          ymin: block.ymin,
          xmax: block.xmax,
          ymax: block.ymax,
        },
        config: {
          padding: inpaintConfig.padding,
          targetSize: inpaintConfig.targetSize,
          maskThreshold: inpaintConfig.maskThreshold,
          maskErosion: inpaintConfig.maskErosion,
          maskDilation: inpaintConfig.maskDilation,
          featherRadius: inpaintConfig.featherRadius,
          debugMode: inpaintConfig.exportTriptychs,
        },
      })

      const blob = new Blob([new Uint8Array(result.image)])
      const bitmap = await createImageBitmap(blob)

      await compositeMaskedRegion(
        ctx,
        bitmap,
        result.x,
        result.y,
        result.width,
        result.height,
        block,
        segmentationMask,
        image.bitmap.width,
        image.bitmap.height,
        {
          featherRadius: inpaintConfig.featherRadius,
          autoSeamFix: inpaintConfig.autoSeamFix,
          seamThreshold: inpaintConfig.seamThreshold,
        }
      )
    }

    const textlessBlob = await canvas.convertToBlob({ type: 'image/png' })
    const textlessBuffer = await textlessBlob.arrayBuffer()
    return createImageFromBuffer(textlessBuffer)
  }

  private async prepareBlocksForRendering(
    image: Image,
    blocks: TextBlock[],
    defaultFont: string
  ): Promise<TextBlock[]> {
    const updated: TextBlock[] = []

    for (const block of blocks) {
      if (!block.translatedText) {
        updated.push(block)
        continue
      }

      const colors = await extractBackgroundColor(image.bitmap, block, 10)
      let backgroundColor = block.manualBgColor || colors.backgroundColor
      let textColor = block.manualTextColor || colors.textColor

      if (!block.manualBgColor && !block.manualTextColor) {
        const readable = ensureReadableContrast(backgroundColor, textColor, 4.5)
        backgroundColor = readable.bgColor
        textColor = readable.textColor
      }

      const fontFamily = block.fontFamily || defaultFont
      const fontMetrics = block.maskStats
        ? calculateImprovedFontSize(block, block.translatedText, fontFamily)
        : (() => {
            const boxWidth = block.xmax - block.xmin
            const boxHeight = block.ymax - block.ymin
            const classic = calculateOptimalFontSize(block.translatedText, boxWidth, boxHeight, fontFamily, 0.1)
            return {
              fontSize: classic.fontSize,
              lineHeight: 1.2,
              letterSpacing: 0,
              alignment: 'center' as const,
            }
          })()

      updated.push({
        ...block,
        backgroundColor,
        textColor,
        fontSize: fontMetrics.fontSize,
        lineHeight: fontMetrics.lineHeight,
        letterSpacing: fontMetrics.letterSpacing,
        fontFamily,
      })
    }

    return updated
  }

  private async renderFinalImage(params: {
    image: Image
    textlessImage: Image | null
    textBlocks: TextBlock[]
    renderMethod: BatchConfig['renderMethod']
  }): Promise<RenderArtifacts> {
    const { image, textlessImage, textBlocks, renderMethod } = params
    const canvas = new OffscreenCanvas(image.bitmap.width, image.bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to obtain canvas context for rendering')

    const baseBitmap =
      renderMethod === 'rectangle'
        ? image.bitmap
        : textlessImage?.bitmap ?? image.bitmap

    ctx.drawImage(baseBitmap, 0, 0)

    let rectanglesBuffer: ArrayBuffer | null = null

    if (renderMethod === 'rectangle') {
      for (const block of textBlocks) {
        if (!block.backgroundColor) continue
        const bg = block.manualBgColor || block.backgroundColor
        const width = block.xmax - block.xmin
        const height = block.ymax - block.ymin
        ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`
        ctx.beginPath()
        ctx.roundRect(block.xmin, block.ymin, width, height, 5)
        ctx.fill()
      }
      const rectanglesBlob = await canvas.convertToBlob({ type: 'image/png' })
      rectanglesBuffer = await rectanglesBlob.arrayBuffer()
    }

    for (const block of textBlocks) {
      if (!block.translatedText || !block.fontSize || !block.textColor) continue
      const textColor = block.manualTextColor || block.textColor
      ctx.font = `${block.fontStretch || 'normal'} ${block.fontWeight || 'normal'} ${block.fontSize}px ${
        block.fontFamily || 'Arial'
      }`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`
      const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
      if (hasOutline) {
        const outline = block.appearance!.sourceOutlineColor!
        ctx.strokeStyle = `rgb(${outline.r}, ${outline.g}, ${outline.b})`
        ctx.lineWidth = block.appearance!.outlineWidthPx!
        ctx.lineJoin = 'round'
        ctx.miterLimit = 2
      }

      const boxWidth = block.xmax - block.xmin
      const boxHeight = block.ymax - block.ymin
      const maxWidth = boxWidth * 0.9
      const centerX = (block.xmin + block.xmax) / 2
      const centerY = (block.ymin + block.ymax) / 2

      const words = block.translatedText.split(' ')
      const lines: string[] = []
      let currentLine = ''
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word
        const metrics = ctx.measureText(testLine)
        if (metrics.width > maxWidth && currentLine) {
          lines.push(currentLine)
          currentLine = word
        } else {
          currentLine = testLine
        }
      }
      if (currentLine) lines.push(currentLine)

      const lineHeight = block.fontSize * (block.lineHeight ?? 1.2)
      const totalHeight = lines.length * lineHeight
      const startY =
        totalHeight > boxHeight * 0.9
          ? block.ymin + lineHeight / 2
          : centerY - ((lines.length - 1) * lineHeight) / 2

      lines.forEach((line, idx) => {
        const y = startY + idx * lineHeight
        if (hasOutline) ctx.strokeText(line, centerX, y, maxWidth)
        ctx.fillText(line, centerX, y, maxWidth)
      })
    }

    const finalBlob = await canvas.convertToBlob({ type: 'image/png', quality: 1.0 })
    const finalBuffer = await finalBlob.arrayBuffer()

    return { finalBuffer, rectanglesBuffer }
  }

  private async saveOutputs(
    index: number,
    page: BatchPage,
    artifacts: RenderArtifacts,
    textBlocks: TextBlock[],
    config: BatchConfig
  ): Promise<{ outputImagePath: string; manifestPath: string }> {
    const state = this.getState()
    const outputDir = state.outputDir
    if (!outputDir) throw new Error('Output directory not selected')

    await createDir(outputDir, { recursive: true })

    const originalName = await basename(page.fileName)
  const baseName = originalName.replace(/\.[^/.]+$/, '')
  const originalExtension = await extname(page.fileName)
  const extension = '.png'
    const indexPrefix = String(index + 1).padStart(3, '0')

    const outputFileName = `${indexPrefix}-${baseName}${extension}`
    const outputImagePath = await join(outputDir, outputFileName)
    await writeBinaryFile({ path: outputImagePath, contents: new Uint8Array(artifacts.finalBuffer) })

    let rectanglesPath: string | null = null
    if (config.renderMethod === 'rectangle' && artifacts.rectanglesBuffer) {
      const rectanglesName = `${indexPrefix}-${baseName}-rectangles${extension}`
      rectanglesPath = await join(outputDir, rectanglesName)
      await writeBinaryFile({ path: rectanglesPath, contents: new Uint8Array(artifacts.rectanglesBuffer) })
    }

    const manifest = {
      sourcePath: page.sourcePath,
      fileName: page.fileName,
      createdAt: new Date().toISOString(),
      renderMethod: config.renderMethod,
  originalExtension: originalExtension || null,
      outputImage: outputFileName,
      outputPath: outputImagePath,
      rectanglesPath,
      textBlocks: textBlocks.map((block, idx) => ({
        index: idx,
        bbox: {
          xmin: block.xmin,
          ymin: block.ymin,
          xmax: block.xmax,
          ymax: block.ymax,
        },
        text: block.text,
        translatedText: block.translatedText,
        backgroundColor: block.backgroundColor,
        textColor: block.textColor,
        fontSize: block.fontSize,
        fontFamily: block.fontFamily,
        lineHeight: block.lineHeight,
        letterSpacing: block.letterSpacing,
      })),
      warnings: page.warnings ?? [],
      timings: page.stageTimings,
    }

    const manifestName = `${indexPrefix}-${baseName}.json`
    const manifestPath = await join(outputDir, manifestName)
    await writeTextFile(manifestPath, JSON.stringify(manifest, null, 2))

    return { outputImagePath, manifestPath }
  }
}