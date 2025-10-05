'use client'

import { Image, Moon, Sun } from 'lucide-react'
import { Button, IconButton, Badge } from '@radix-ui/themes'
import { fileOpen } from 'browser-fs-access'
import { useEditorStore, PipelineStage, selectStageStatuses } from '@/lib/state'
import { createImageFromBlob } from '@/lib/image'
import SettingsDialog from './settings-dialog'
import DetectionControls from './detection-controls'

function Topbar() {
  const loadImageSession = useEditorStore((state) => state.loadImageSession)
  const theme = useEditorStore((state) => state.theme)
  const setTheme = useEditorStore((state) => state.setTheme)
  const tool = useEditorStore((state) => state.tool)
  const currentStage = useEditorStore((state) => state.currentStage)
  const setCurrentStage = useEditorStore((state) => state.setCurrentStage)
  const stageStatuses = useEditorStore(selectStageStatuses)

  const handleOpenImage = async () => {
    try {
      const blob = await fileOpen({
        multiple: false,
        mimeTypes: ['image/*'],
      })

      if (!blob) return

      const image = await createImageFromBlob(blob)
      loadImageSession(image)
    } catch (err) {
      alert(`Error opening image: ${err}`)
    }
  }

  const stageLabels: Record<PipelineStage, string> = {
    original: 'Original',
    textless: 'Clean Plate',
    rectangles: '+Backgrounds',
    final: 'Final',
  }

  return (
    <div className='flex w-full items-center border-b border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-900'>
      <div className='mx-1 flex items-center'>
        <Button onClick={handleOpenImage} variant='soft'>
          <Image size={20} />
        </Button>
      </div>

      <div className='flex-grow flex items-center justify-center gap-2'>
        {tool === 'detection' && <DetectionControls />}

        {/* Pipeline Stage Viewer */}
        {(tool === 'render' || tool === 'inpaint') && (
          <div className='flex items-center gap-1'>
            {stageStatuses.map((status) => {
              const isActive = currentStage === status.stage

              return (
                <Button
                  key={status.stage}
                  size='1'
                  variant={isActive ? 'solid' : 'soft'}
                  color={isActive ? 'blue' : 'gray'}
                  disabled={!status.isSelectable}
                  onClick={() => setCurrentStage(status.stage)}
                >
                  {stageLabels[status.stage]}
                  {!status.isAvailable && <Badge size='1' color='gray' ml='1'>-</Badge>}
                </Button>
              )
            })}
          </div>
        )}
      </div>

      <div className='mx-1 flex items-center gap-1'>
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
