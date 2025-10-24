'use client'

import { Play, AlertTriangle, Pencil } from 'lucide-react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Badge, Button, Callout, TextArea } from '@radix-ui/themes'
import { imageBitmapToArrayBuffer } from '@/utils/image'
import { useEditorStore } from '@/lib/state'
import { invoke } from '@tauri-apps/api/core'

export default function OCRPanel() {
  const {
    image,
    textBlocks,
    setTextBlocks,
    setSelectedBlockIndex,
  } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [editingBlock, setEditingBlock] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const autoOcrTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const autosaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const latestEditRef = useRef<{ index: number | null; value: string }>({ index: null, value: '' })
  const latestBlocksRef = useRef(textBlocks)
  const staleCount = textBlocks.filter((b) => b.ocrStale).length
  const manualEditsCount = textBlocks.filter((b) => b.manuallyEditedText).length

  const persistManualEdit = useCallback(
    (index: number, value: string, sourceBlocks?: typeof textBlocks) => {
      const blocksSnapshot = sourceBlocks ?? textBlocks
      const updated = [...blocksSnapshot]
      const block = updated[index]
      if (!block) return

      const changed = block.text !== value

      updated[index] = {
        ...block,
        text: value,
        manuallyEditedText: changed ? true : block.manuallyEditedText,
        translatedText: changed ? undefined : block.translatedText,
        ocrStale: false,
      }
      setTextBlocks(updated)
    },
    [textBlocks, setTextBlocks]
  )

  const finishEditing = useCallback(() => {
    if (editingBlock !== null) {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
      }
      persistManualEdit(editingBlock, editValue)
    }
    setEditingBlock(null)
    setEditValue('')
  }, [editingBlock, editValue, persistManualEdit])

  const run = useCallback(async () => {
    if (!image || !textBlocks.length) return

    finishEditing()

    setLoading(true)
    let cachePrimed = false
    let cacheDuration = 0

    try {
      const runId = Math.floor(performance.now())
      const totalStart = performance.now()

      const cacheStart = performance.now()
      const imageBuffer = await imageBitmapToArrayBuffer(image.bitmap)
      await invoke('cache_ocr_image', {
        imagePng: Array.from(new Uint8Array(imageBuffer)),
      })
      cachePrimed = true
      cacheDuration = performance.now() - cacheStart
      console.info(
        `[ocr] run=${runId} cachePrime=${cacheDuration.toFixed(1)}ms payload=${(imageBuffer.byteLength / 1024).toFixed(1)}KB`
      )

      const prepareTimings: number[] = []
      const invokeTimings: number[] = []
      const updateTimings: number[] = []
      const pixelAreas: number[] = []
      const updatedBlocks = []

      for (const [index, block] of textBlocks.entries()) {
        const prepareStart = performance.now()
        const bbox = {
          xmin: block.xmin,
          ymin: block.ymin,
          xmax: block.xmax,
          ymax: block.ymax,
        }
        const blockWidth = Math.max(0, block.xmax - block.xmin)
        const blockHeight = Math.max(0, block.ymax - block.ymin)
        const pixelArea = Math.max(1, Math.round(blockWidth * blockHeight))
        const prepareDuration = performance.now() - prepareStart

        const invokeStart = performance.now()
        const ocrResults = await invoke<string[]>('ocr_cached_block', { bbox })
        const invokeDuration = performance.now() - invokeStart

        const updateStart = performance.now()
        const result = ocrResults.length > 0 ? ocrResults[0] : ''
        updatedBlocks.push({
          ...block,
          text: result,
          translatedText: undefined,
          manuallyEditedText: false,
          ocrStale: false,
        })
        const updateDuration = performance.now() - updateStart

        prepareTimings.push(prepareDuration)
        invokeTimings.push(invokeDuration)
        updateTimings.push(updateDuration)
        pixelAreas.push(pixelArea)

        console.info(
          `[ocr] run=${runId} block=${index + 1}/${textBlocks.length} prepare=${prepareDuration.toFixed(1)}ms area=${pixelArea}px invoke=${invokeDuration.toFixed(1)}ms update=${updateDuration.toFixed(1)}ms`
        )
      }

      setTextBlocks(updatedBlocks)

      const totalDuration = performance.now() - totalStart
      const blocksCount = textBlocks.length || 1
      const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / blocksCount
      const maxArea = Math.max(...pixelAreas)
      const minArea = Math.min(...pixelAreas)

      console.info(
        `[ocr] run=${runId} summary total=${totalDuration.toFixed(1)}ms avg=${(totalDuration / blocksCount).toFixed(1)}ms ` +
          `cachePrime=${cacheDuration.toFixed(1)}ms prepareAvg=${avg(prepareTimings).toFixed(1)}ms invokeAvg=${avg(invokeTimings).toFixed(1)}ms updateAvg=${avg(updateTimings).toFixed(1)}ms ` +
          `areaAvg=${avg(pixelAreas).toFixed(1)}px areaRange=${minArea}-${maxArea}px`
      )
    } catch (error) {
      console.error('Error during OCR:', error)
    } finally {
      if (cachePrimed) {
        try {
          await invoke('clear_ocr_cache')
        } catch (cacheError) {
          console.warn('Failed to clear OCR cache', cacheError)
        }
      }
      setLoading(false)
    }
  }, [finishEditing, image, textBlocks, setTextBlocks])

  // Auto-trigger OCR when boxes become stale (with debounce)
  useEffect(() => {
    if (editingBlock !== null) {
      return
    }

    if (staleCount > 0 && !loading) {
      if (autoOcrTimeoutRef.current) {
        clearTimeout(autoOcrTimeoutRef.current)
      }

      autoOcrTimeoutRef.current = setTimeout(() => {
        console.log(`Auto-triggering OCR for ${staleCount} stale box(es)`)
        run()
      }, 1500)
    }

    return () => {
      if (autoOcrTimeoutRef.current) {
        clearTimeout(autoOcrTimeoutRef.current)
      }
    }
  }, [staleCount, loading, editingBlock, run])

  // Cleanup autosave timer on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
      }
    }
  }, [])

  // Track latest edit state for unmount persistence
  useEffect(() => {
    latestEditRef.current = { index: editingBlock, value: editValue }
  }, [editingBlock, editValue])

  useEffect(() => {
    latestBlocksRef.current = textBlocks
  }, [textBlocks])

  // Persist ongoing edits if component unmounts while editing
  useEffect(() => {
    return () => {
      const { index, value } = latestEditRef.current
      if (index !== null) {
        persistManualEdit(index, value, latestBlocksRef.current)
      }
    }
  }, [persistManualEdit])

  const handleEditChange = useCallback((index: number, value: string) => {
    setEditValue(value)

    if (autosaveTimeoutRef.current) {
      clearTimeout(autosaveTimeoutRef.current)
    }

    autosaveTimeoutRef.current = setTimeout(() => {
      persistManualEdit(index, value)
    }, 400)
  }, [persistManualEdit])

  const startEditing = useCallback((index: number) => {
    if (editingBlock !== null && editingBlock !== index) {
      finishEditing()
    }
    if (autoOcrTimeoutRef.current) {
      clearTimeout(autoOcrTimeoutRef.current)
    }
    setEditingBlock(index)
    setEditValue(textBlocks[index]?.text || '')
    setSelectedBlockIndex(index)
  }, [editingBlock, finishEditing, setSelectedBlockIndex, textBlocks])

  return (
    <div className='flex max-h-[600px] w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md dark:border-gray-700 dark:bg-gray-800'>
      {/* Header */}
      <div className='flex flex-shrink-0 items-center-safe p-3'>
        <h2 className='font-medium text-gray-900 dark:text-gray-100'>OCR</h2>
        <div className='flex-grow'></div>
        <Button onClick={run} loading={loading} variant='soft'>
          <Play className='h-4 w-4' />
        </Button>
      </div>

      {/* Stale OCR Warning */}
      {staleCount > 0 && !loading && (
        <div className='px-3 pb-2'>
          <Callout.Root size='1' color='orange'>
            <Callout.Icon>
              <AlertTriangle className='h-3 w-3' />
            </Callout.Icon>
            <Callout.Text>
              {staleCount} box{staleCount > 1 ? 'es' : ''} moved. Auto-refreshing OCR...
            </Callout.Text>
          </Callout.Root>
        </div>
      )}

      {/* Manual edit notice */}
      {manualEditsCount > 0 && (
        <div className='px-3 pb-2'>
          <Callout.Root size='1' color='blue'>
            <Callout.Icon>
              <Pencil className='h-3 w-3' />
            </Callout.Icon>
            <Callout.Text>
              {manualEditsCount} block{manualEditsCount > 1 ? 's have' : ' has'} manual OCR edits. Re-run translation to refresh English text.
            </Callout.Text>
          </Callout.Root>
        </div>
      )}

      <div className='flex flex-col overflow-y-auto'>
        {textBlocks?.map((block, index) => (
          <div
            key={index}
            className={`border-b border-gray-200 px-4 py-2 text-sm last:border-b-0 transition-colors dark:border-gray-700 ${
              block.ocrStale
                ? 'bg-orange-50 dark:bg-orange-900/40'
                : editingBlock === index
                  ? 'bg-blue-50 dark:bg-blue-900/40'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <div className='flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400'>
              <Badge color={block.ocrStale ? 'orange' : block.manuallyEditedText ? 'blue' : undefined}>
                {index + 1}
              </Badge>
              {block.ocrStale && <AlertTriangle className='h-3 w-3 text-orange-500' />}
              {block.manuallyEditedText && !block.ocrStale && <Pencil className='h-3 w-3 text-blue-500' />}
              <span className='uppercase tracking-wide'>OCR</span>
            </div>

            <div className='mt-1'>
              {editingBlock === index ? (
                <TextArea
                  value={editValue}
                  onChange={(e) => handleEditChange(index, e.target.value)}
                  onBlur={finishEditing}
                  rows={Math.max(3, Math.ceil((block.text?.length || 0) / 30))}
                  autoFocus
                  className='w-full dark:bg-gray-900 dark:text-gray-100'
                />
              ) : (
                <div
                  className='cursor-text whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-100'
                  onClick={() => startEditing(index)}
                  role='textbox'
                  tabIndex={0}
                  onFocus={() => startEditing(index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      startEditing(index)
                    }
                  }}
                >
                  {block.text ? (
                    block.text
                  ) : (
                    <span className='text-gray-400 dark:text-gray-500'>No text detected</span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
