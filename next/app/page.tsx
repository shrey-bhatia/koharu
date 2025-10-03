'use client'

import { useEffect } from 'react'
import DetectionPanel from '@/components/detection-panel'
import Tools from '@/components/tools'
import Topbar from '@/components/topbar'
import Canvas from '@/components/canvas'
import OCRPanel from '@/components/ocr-panel'
import TranslationPanel from '@/components/translation-panel'
import InpaintPanel from '@/components/inpaint-panel'
import RenderPanel from '@/components/render-panel'
import { useEditorStore } from '@/lib/state'

function App() {
  const { tool: selectedTool, theme } = useEditorStore()

  // Apply theme on mount
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }
  }, [theme])

  return (
    <main className='flex h-screen max-h-screen w-screen max-w-screen flex-col bg-gray-100 dark:bg-gray-900'>
      <Topbar />
      <div className='flex flex-1 overflow-hidden dark:bg-gray-900'>
        <div className='flex h-full w-20 items-start p-3'>
          <Tools />
        </div>

        <div className='flex flex-1 flex-col items-center justify-center'>
          <Canvas />
        </div>

        <div className='flex h-full w-72 flex-col gap-2 overflow-y-auto p-3'>
          {selectedTool === 'detection' && (
            <>
              <DetectionPanel />
              <OCRPanel />
            </>
          )}
          {selectedTool === 'translation' && <TranslationPanel />}
          {selectedTool === 'inpaint' && <InpaintPanel />}
          {selectedTool === 'render' && <RenderPanel />}
        </div>
      </div>
    </main>
  )
}

export default App
