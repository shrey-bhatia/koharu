'use client'

import { Image as ImageIcon, Moon, Sun, Clipboard, ChevronUp, ChevronDown } from 'lucide-react'
import { Button, IconButton, Badge, Slider } from '@radix-ui/themes'
import { fileOpen } from 'browser-fs-access'
import { useEditorStore } from '@/lib/state'
import { createImageFromBlob } from '@/lib/image'
import SettingsDialog from './settings-dialog'
import DetectionControls from './detection-controls'

function Topbar() {
  const { setImage, theme, setTheme, tool, currentStage, setCurrentStage, pipelineStages, renderMethod, textBlocks, fontSizeStep, setFontSizeStep, setTextBlocks } = useEditorStore()

  const handleOpenImage = async () => {
    try {
      const blob = await fileOpen({
        multiple: false,
        mimeTypes: ['image/*'],
      })

      if (!blob) return

      const image = await createImageFromBlob(blob)
      setImage(image)
    } catch (err) {
      alert(`Error opening image: ${err}`)
    }
  }

  const handlePasteImage = async () => {
    try {
      const clipboardItems = await navigator.clipboard.read()
      let blob: Blob | null = null

      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            blob = await item.getType(type)
            break
          }
        }
        if (blob) break
      }

      if (!blob) {
        alert('No image found in clipboard.')
        return
      }

      const image = await createImageFromBlob(blob)
      setImage(image)
    } catch (err) {
      alert(`Error pasting image: ${err}`)
    }
  }

  const increaseFontSize = () => {
    const updated = textBlocks.map(block => ({
      ...block,
      fontSize: Math.max(1, (block.fontSize || 16) + fontSizeStep)
    }))
    setTextBlocks(updated)
  }

  const decreaseFontSize = () => {
    const updated = textBlocks.map(block => ({
      ...block,
      fontSize: Math.max(1, (block.fontSize || 16) - fontSizeStep)
    }))
    setTextBlocks(updated)
  }

  const stageLabels = {
    original: 'Original',
    textless: 'Textless',
    rectangles: '+Backgrounds',
    final: 'Final'
  }

  return (
    <div className='flex w-full items-center border-b border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-900'>
      <div className='mx-1 flex items-center'>
        <Button onClick={handleOpenImage} variant='soft'>
          <ImageIcon size={20} />
        </Button>
        <Button onClick={handlePasteImage} variant='soft'>
          <Clipboard size={20} />
        </Button>
      </div>

      <div className='flex-grow flex items-center justify-center gap-2'>
        {tool === 'detection' && <DetectionControls />}

        {/* Pipeline Stage Viewer */}
        {(tool === 'render' || tool === 'inpaint') && (
          <div className='flex items-center gap-1'>
            {(['original', 'textless', 'rectangles', 'final'] as const)
              .filter(stage => {
                // Hide +Backgrounds stage for LaMa/NewLaMa methods since rectangles don't apply
                if (stage === 'rectangles' && (renderMethod === 'lama' || renderMethod === 'newlama')) {
                  return false
                }
                return true
              })
              .map((stage) => {
                const stageName = stage === 'rectangles' ? 'withRectangles' : stage
                const hasStage = stage === 'original' || pipelineStages[stageName as keyof typeof pipelineStages] !== null
                const isActive = currentStage === stage

                return (
                  <Button
                    key={stage}
                    size='1'
                    variant={isActive ? 'solid' : 'soft'}
                    color={isActive ? 'blue' : 'gray'}
                    disabled={!hasStage}
                    onClick={() => setCurrentStage(stage)}
                  >
                    {stageLabels[stage]}
                    {!hasStage && <Badge size='1' color='gray' ml='1'>-</Badge>}
                  </Button>
                )
              })}
          </div>
        )}
      </div>

      <div className='mx-1 flex items-center gap-1'>
        {textBlocks.some(b => b.translatedText) && (
          <>
            <div className='flex items-center gap-2'>
              <span className='text-sm'>Font Size Step:</span>
              <Slider
                value={[fontSizeStep]}
                onValueChange={(value) => setFontSizeStep(value[0])}
                min={1}
                max={10}
                step={1}
                className='w-16'
              />
              <input
                type='number'
                value={fontSizeStep}
                onChange={(e) => setFontSizeStep(parseInt(e.target.value) || 1)}
                min={1}
                max={10}
                className='w-12 px-1 py-0.5 text-sm border rounded'
              />
            </div>
            <Button onClick={decreaseFontSize} size='1' variant='soft'>
              <ChevronDown size={16} /> A
            </Button>
            <Button onClick={increaseFontSize} size='1' variant='soft'>
              <ChevronUp size={16} /> A
            </Button>
          </>
        )}
        <IconButton
          variant='ghost'
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
        </IconButton>
        <SettingsDialog />
      </div>
    </div>
  )
}

export default Topbar
