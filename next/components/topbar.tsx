'use client'

import { Image, Moon, Sun } from 'lucide-react'
import { Button, IconButton } from '@radix-ui/themes'
import { fileOpen } from 'browser-fs-access'
import { useEditorStore } from '@/lib/state'
import { createImageFromBlob } from '@/lib/image'
import SettingsDialog from './settings-dialog'
import DetectionControls from './detection-controls'

function Topbar() {
  const { setImage, theme, setTheme, tool } = useEditorStore()

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

  return (
    <div className='flex w-full items-center border-b border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-900'>
      <div className='mx-1 flex items-center'>
        <Button onClick={handleOpenImage} variant='soft'>
          <Image size={20} />
        </Button>
      </div>

      <div className='flex-grow flex items-center justify-center'>
        {tool === 'detection' && <DetectionControls />}
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
