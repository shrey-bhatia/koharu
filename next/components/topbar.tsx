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

  const stageLabels: Record<string, string> = {
    original: 'Original',
    textless: 'Textless',
    withRectangles: '+Backgrounds',
    final: 'Final'
  }

  return (
    <div className='glass flex w-full items-center border-b border-gray-200/60 bg-white/70 px-3 py-1.5 dark:border-white/[.06] dark:bg-gray-900/60'>
      <div className='flex items-center gap-1'>
        <Button onClick={handleOpenImage} variant='ghost' size='1'>
          <ImageIcon size={18} />
        </Button>
        <Button onClick={handlePasteImage} variant='ghost' size='1'>
          <Clipboard size={18} />
        </Button>
      </div>

      <div className='flex-grow flex items-center justify-center gap-1.5'>
        {tool === 'detection' && <DetectionControls />}

        {/* Pipeline Stage Viewer */}
        {(tool === 'render' || tool === 'inpaint') && (
          <div className='flex items-center gap-0.5 rounded-full bg-gray-100/80 p-0.5 dark:bg-white/[.06]'>
            {(['original', 'textless', 'withRectangles', 'final'] as const)
              .filter(stage => {
                // Hide +Backgrounds stage for LaMa/NewLaMa methods since rectangles don't apply
                if (stage === 'withRectangles' && (renderMethod === 'lama' || renderMethod === 'newlama')) {
                  return false
                }
                return true
              })
              .map((stage) => {
                const hasStage = stage === 'original' || pipelineStages[stage] !== null
                const isActive = currentStage === stage

                return (
                  <Button
                    key={stage}
                    size='1'
                    variant={isActive ? 'solid' : 'ghost'}
                    color={isActive ? 'indigo' : 'gray'}
                    disabled={!hasStage}
                    onClick={() => setCurrentStage(stage)}
                    style={{ borderRadius: '9999px' }}
                  >
                    {stageLabels[stage]}
                    {!hasStage && <Badge size='1' color='gray' ml='1'>-</Badge>}
                  </Button>
                )
              })}
          </div>
        )}
      </div>

      <div className='flex items-center gap-1'>
        {textBlocks.some(b => b.translatedText) && (
          <>
            <div className='flex items-center gap-1.5 rounded-lg bg-gray-100/80 px-2 py-1 dark:bg-white/[.06]'>
              <span className='text-xs text-gray-500 dark:text-gray-400'>Step</span>
              <Slider
                value={[fontSizeStep]}
                onValueChange={(value) => setFontSizeStep(value[0])}
                min={1}
                max={10}
                step={1}
                className='w-14'
              />
              <input
                type='number'
                value={fontSizeStep}
                onChange={(e) => setFontSizeStep(parseInt(e.target.value) || 1)}
                min={1}
                max={10}
                className='w-10 rounded-md border border-gray-200 bg-white/60 px-1 py-0.5 text-center text-xs tabular-nums dark:border-white/10 dark:bg-white/5 dark:text-gray-200'
              />
            </div>
            <Button onClick={decreaseFontSize} size='1' variant='ghost'>
              <ChevronDown size={14} /> A
            </Button>
            <Button onClick={increaseFontSize} size='1' variant='ghost'>
              <ChevronUp size={14} /> A
            </Button>
          </>
        )}
        <IconButton
          variant='ghost'
          size='1'
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </IconButton>
        <SettingsDialog />
      </div>
    </div>
  )
}

export default Topbar
