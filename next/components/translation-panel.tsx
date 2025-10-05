'use client'

import { Badge, Button, Text, TextArea, Callout } from '@radix-ui/themes'
import { Play, AlertCircle } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useEditorStore } from '@/lib/state'
import { translate, TranslationAPIError } from '@/utils/translation'

function TranslationPanel() {
  const {
    textBlocks,
    setTextBlocks,
    translationApiKey,
    deeplApiKey,
    ollamaModel,
    ollamaSystemPrompt,
    translationProvider,
  } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [editingBlock, setEditingBlock] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const autosaveTimeout = useRef<NodeJS.Timeout | null>(null)

  const runTranslation = async () => {
    // Get the appropriate API key based on selected provider (Ollama doesn't need one)
    const currentApiKey = translationProvider === 'google'
      ? translationApiKey
      : translationProvider === 'ollama'
      ? 'not-needed' // Ollama doesn't require API key
      : deeplApiKey

    // Check for API key (skip for Ollama)
    if (!currentApiKey && translationProvider !== 'ollama') {
      const providerName = translationProvider === 'google'
        ? 'Google Cloud Translation'
        : translationProvider === 'deepl-free'
        ? 'DeepL Free'
        : 'DeepL Pro'
      setError(`API key not set. Click the settings icon in the top bar to add your ${providerName} API key.`)
      return
    }

    // Check for text blocks with OCR results
    const blocksToTranslate = textBlocks.filter((block) => block.text && block.text.trim().length > 0)
    if (blocksToTranslate.length === 0) {
      setError('No text to translate. Run Detection and OCR first.')
      return
    }

    setLoading(true)
    setError(null)
    setProgress('')

    try {
      const updatedBlocks = [...textBlocks]

      // Translate each text block
      for (let i = 0; i < updatedBlocks.length; i++) {
        const block = updatedBlocks[i]

        // Skip blocks without OCR text
        if (!block.text || block.text.trim().length === 0) {
          continue
        }

        setProgress(`Translating block ${i + 1}/${textBlocks.length}...`)

        try {
          const translated = await translate(
            block.text,
            translationProvider,
            currentApiKey,
            'ja',
            'en',
            ollamaModel,
            ollamaSystemPrompt
          )
          updatedBlocks[i] = { ...block, translatedText: translated }
        } catch (err) {
          if (err instanceof TranslationAPIError) {
            if (err.code === 403 || err.code === 401) {
              throw new Error('Invalid API key. Please check your settings.')
            } else if (err.code === 429) {
              throw new Error('Rate limit exceeded. Please wait a moment and try again.')
            } else {
              throw new Error(`Translation API error: ${err.message}`)
            }
          }
          throw err
        }

        // Small delay to avoid rate limits
        if (i < updatedBlocks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      setTextBlocks(updatedBlocks)
      setProgress('Translation complete!')
    } catch (err) {
      console.error('Translation error:', err)
      setError(err instanceof Error ? err.message : 'Translation failed')
    } finally {
      setLoading(false)
    }
  }

  const handleEditChange = (index: number, value: string) => {
    setEditValue(value)

    // Clear existing timeout
    if (autosaveTimeout.current) {
      clearTimeout(autosaveTimeout.current)
    }

    // Set new timeout for autosave (500ms after user stops typing)
    autosaveTimeout.current = setTimeout(() => {
      const updated = [...textBlocks]
      updated[index] = { ...updated[index], translatedText: value }
      setTextBlocks(updated)
      console.log(`Autosaved translation for block ${index + 1}`)
    }, 500)
  }

  const startEditing = (index: number) => {
    setEditingBlock(index)
    setEditValue(textBlocks[index].translatedText || '')
  }

  const finishEditing = () => {
    // Clear timeout and save immediately
    if (autosaveTimeout.current) {
      clearTimeout(autosaveTimeout.current)
    }
    if (editingBlock !== null) {
      const updated = [...textBlocks]
      updated[editingBlock] = { ...updated[editingBlock], translatedText: editValue }
      setTextBlocks(updated)
    }
    setEditingBlock(null)
    setEditValue('')
  }

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimeout.current) {
        clearTimeout(autosaveTimeout.current)
      }
    }
  }, [])

  // Determine if translation is available (has API key for current provider, or is Ollama)
  const currentApiKey = translationProvider === 'google'
    ? translationApiKey
    : translationProvider === 'ollama'
    ? true // Ollama doesn't need API key
    : deeplApiKey
  const canTranslate = !!currentApiKey

  return (
    <div className='flex max-h-[800px] w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md dark:border-gray-700 dark:bg-gray-800'>
      {/* Header */}
      <div className='flex items-center p-3'>
        <h2 className='font-medium dark:text-white'>Translation</h2>
        <div className='flex-grow'></div>
        <Button onClick={runTranslation} loading={loading} variant='soft' disabled={!canTranslate}>
          <Play className='h-4 w-4' />
        </Button>
      </div>

      {/* Error display */}
      {error && (
        <div className='px-3 pb-2'>
          <Callout.Root color='red' size='1'>
            <Callout.Icon>
              <AlertCircle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        </div>
      )}

      {/* Progress display */}
      {progress && loading && (
        <div className='px-4 py-2'>
          <Text className='text-sm text-gray-600 dark:text-gray-400'>{progress}</Text>
        </div>
      )}

      {/* Success message */}
      {progress && !loading && (
        <div className='px-3 pb-2'>
          <Callout.Root color='green' size='1'>
            <Callout.Text>{progress}</Callout.Text>
          </Callout.Root>
        </div>
      )}

      {/* Translations list */}
      <div className='flex flex-col overflow-y-auto'>
        {textBlocks.map((block, index) => (
          <div
            key={index}
            className='border-b border-gray-200 px-4 py-2 text-sm last:border-b-0 dark:border-gray-700'
          >
            <div className='mb-1 flex items-center gap-2'>
              <Badge>{index + 1}</Badge>
              {block.text && !block.translatedText && (
                <Text className='text-xs text-gray-500 dark:text-gray-400'>Not translated yet</Text>
              )}
            </div>
            {block.text && (
              <div className='space-y-1'>
                <div>
                  <Text className='text-xs font-semibold text-gray-600 dark:text-gray-400'>Original:</Text>
                  <Text className='text-sm dark:text-gray-200'>{block.text}</Text>
                </div>
                {block.translatedText && (
                  <div>
                    <Text className='text-xs font-semibold text-gray-600 dark:text-gray-400'>Translation:</Text>
                    {editingBlock === index ? (
                      <TextArea
                        value={editValue}
                        onChange={(e) => handleEditChange(index, e.target.value)}
                        onBlur={finishEditing}
                        autoFocus
                        rows={3}
                        className='w-full'
                      />
                    ) : (
                      <div
                        onClick={() => startEditing(index)}
                        className='cursor-pointer rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700'
                        title='Click to edit'
                      >
                        <Text className='text-sm font-medium dark:text-gray-100'>{block.translatedText}</Text>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {!block.text && (
              <Text className='text-xs text-gray-400'>No OCR text</Text>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default TranslationPanel
