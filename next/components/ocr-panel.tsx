'use client'

import { Play, AlertTriangle, Pencil } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { Badge, Button, Callout, TextArea } from '@radix-ui/themes'
import { crop, imageBitmapToArrayBuffer } from '@/utils/image'
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

  const persistManualEdit = (index: number, value: string, sourceBlocks?: typeof textBlocks) => {
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
  }

  const finishEditing = () => {
    if (editingBlock !== null) {
      if (autosaveTimeoutRef.current) {
        clearTimeout(autosaveTimeoutRef.current)
      }
      persistManualEdit(editingBlock, editValue)
    }
    setEditingBlock(null)
    setEditValue('')
  }

  const run = async () => {
    if (!image || !textBlocks.length) return

    finishEditing()

    setLoading(true)
    try {
      const updatedBlocks = []
      for (const block of textBlocks) {
        const { xmin, ymin, xmax, ymax } = block
        const croppedBitmap = await crop(
          image.bitmap,
          Math.floor(xmin),
          Math.floor(ymin),
          Math.floor(xmax - xmin),
          Math.floor(ymax - ymin)
        )
        const croppedBuffer = await imageBitmapToArrayBuffer(croppedBitmap)
        const ocrResults = await invoke<string[]>('ocr', {
          image: Array.from(new Uint8Array(croppedBuffer)),
        })
        const result = ocrResults.length > 0 ? ocrResults[0] : ''
        updatedBlocks.push({
          ...block,
          text: result,
          translatedText: undefined,
          manuallyEditedText: false,
          ocrStale: false,
        })
      }
      setTextBlocks(updatedBlocks)
    } catch (error) {
      console.error('Error during OCR:', error)
    } finally {
      setLoading(false)
    }
  }

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
  }, [staleCount, loading, editingBlock])

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
  }, [])

  const handleEditChange = (index: number, value: string) => {
    setEditValue(value)

    if (autosaveTimeoutRef.current) {
      clearTimeout(autosaveTimeoutRef.current)
    }

    autosaveTimeoutRef.current = setTimeout(() => {
      persistManualEdit(index, value)
    }, 400)
  }

  const startEditing = (index: number) => {
    if (editingBlock !== null && editingBlock !== index) {
      finishEditing()
    }
    if (autoOcrTimeoutRef.current) {
      clearTimeout(autoOcrTimeoutRef.current)
    }
    setEditingBlock(index)
    setEditValue(textBlocks[index]?.text || '')
    setSelectedBlockIndex(index)
  }

  return (
    <div className='flex max-h-[600px] w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md'>
      {/* Header */}
      <div className='flex flex-shrink-0 items-center-safe p-3'>
        <h2 className='font-medium'>OCR</h2>
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
            className={`border-b border-gray-200 px-4 py-2 text-sm last:border-b-0 transition-colors ${
              block.ocrStale
                ? 'bg-orange-50'
                : editingBlock === index
                  ? 'bg-blue-50'
                  : 'hover:bg-gray-50'
            }`}
          >
            <div className='flex items-center gap-2 text-xs text-gray-500'>
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
                  className='w-full'
                />
              ) : (
                <div
                  className='cursor-text whitespace-pre-wrap text-sm text-gray-800'
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
                    <span className='text-gray-400'>No text detected</span>
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
