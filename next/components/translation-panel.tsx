'use client'

import { Badge, Button, Text, TextArea, Callout } from '@radix-ui/themes'
import { Play, AlertCircle } from 'lucide-react'
import { useState } from 'react'
import { useEditorStore } from '@/lib/state'
import { translateWithGoogle, TranslationAPIError } from '@/utils/translation'

function TranslationPanel() {
  const { textBlocks, setTextBlocks, translationApiKey } = useEditorStore()
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  const translate = async () => {
    // Check for API key
    if (!translationApiKey) {
      setError('API key not set. Click the settings icon in the top bar to add your Google Cloud Translation API key.')
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
          const translated = await translateWithGoogle(
            block.text,
            translationApiKey
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

  return (
    <div className='flex max-h-[800px] w-full flex-col rounded-lg border border-gray-200 bg-white shadow-md'>
      {/* Header */}
      <div className='flex items-center p-3'>
        <h2 className='font-medium'>Translation</h2>
        <div className='flex-grow'></div>
        <Button onClick={translate} loading={loading} variant='soft' disabled={!translationApiKey}>
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
          <Text className='text-sm text-gray-600'>{progress}</Text>
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
            className='border-b border-gray-200 px-4 py-2 text-sm last:border-b-0'
          >
            <div className='mb-1 flex items-center gap-2'>
              <Badge>{index + 1}</Badge>
              {block.text && !block.translatedText && (
                <Text className='text-xs text-gray-500'>Not translated yet</Text>
              )}
            </div>
            {block.text && (
              <div className='space-y-1'>
                <div>
                  <Text className='text-xs font-semibold text-gray-600'>Original:</Text>
                  <Text className='text-sm'>{block.text}</Text>
                </div>
                {block.translatedText && (
                  <div>
                    <Text className='text-xs font-semibold text-gray-600'>Translation:</Text>
                    <Text className='text-sm font-medium'>{block.translatedText}</Text>
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
