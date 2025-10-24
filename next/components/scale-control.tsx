'use client'

import { useEditorStore } from '@/lib/state'
import { Button } from '@radix-ui/themes'
import { Minus, Plus, Maximize2 } from 'lucide-react'
import { useCallback } from 'react'

interface ScaleControlProps {
  onZoom?: (targetScale: number, mode: 'button' | 'keyboard' | 'wheel') => void
  onReset?: () => void
}

function ScaleControl({ onZoom, onReset }: ScaleControlProps) {
  const { scale, setScale } = useEditorStore()

  const handleZoomIn = useCallback(() => {
    const targetScale = scale * 1.05
    if (onZoom) {
      onZoom(targetScale, 'button')
    } else {
      setScale(Math.min(2.0, targetScale))
    }
  }, [scale, onZoom, setScale])

  const handleZoomOut = useCallback(() => {
    const targetScale = scale * 0.95
    if (onZoom) {
      onZoom(targetScale, 'button')
    } else {
      setScale(Math.max(0.1, targetScale))
    }
  }, [scale, onZoom, setScale])

  const handleResetClick = useCallback(() => {
    if (onReset) {
      onReset()
    } else {
      setScale(1.0)
    }
  }, [onReset, setScale])

  return (
    <div className='absolute bottom-5 left-5 z-10'>
      <div className='flex items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 shadow-sm'>
        <Button
          onClick={handleZoomOut}
          disabled={scale <= 0.1}
          variant='soft'
          size='2'
          title='Zoom out (Ctrl/Cmd + -)'
        >
          <Minus size={18} className='text-gray-700' />
        </Button>
        <button
          onClick={handleResetClick}
          className='mx-1 min-w-[4rem] rounded px-2 py-1 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors'
          title='Fit to viewport (Ctrl/Cmd + 0)'
        >
          {(scale * 100).toFixed(0)}%
        </button>
        <Button
          onClick={handleZoomIn}
          disabled={scale >= 2.0}
          variant='soft'
          size='2'
          title='Zoom in (Ctrl/Cmd + +)'
        >
          <Plus size={18} className='text-gray-700' />
        </Button>
        <div className='mx-1 h-6 w-px bg-gray-300' />
        <Button
          onClick={handleResetClick}
          variant='soft'
          size='2'
          title='Fit to viewport (Ctrl/Cmd + 0)'
        >
          <Maximize2 size={18} className='text-gray-700' />
        </Button>
      </div>
    </div>
  )
}

export default ScaleControl
