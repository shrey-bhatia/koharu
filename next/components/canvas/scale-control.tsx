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
      <div className='glass flex items-center gap-0.5 rounded-full border border-gray-200/60 bg-white/70 p-1 shadow-lg shadow-black/[.04] dark:border-white/[.08] dark:bg-gray-900/60'>
        <Button
          onClick={handleZoomOut}
          disabled={scale <= 0.1}
          variant='ghost'
          size='1'
          title='Zoom out (Ctrl/Cmd + -)'
          style={{ borderRadius: '9999px' }}
        >
          <Minus size={16} className='text-gray-600 dark:text-gray-300' />
        </Button>
        <button
          onClick={handleResetClick}
          className='min-w-[3.5rem] rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums text-gray-600 hover:bg-gray-200/60 dark:text-gray-300 dark:hover:bg-white/10'
          title='Fit to viewport (Ctrl/Cmd + 0)'
        >
          {(scale * 100).toFixed(0)}%
        </button>
        <Button
          onClick={handleZoomIn}
          disabled={scale >= 2.0}
          variant='ghost'
          size='1'
          title='Zoom in (Ctrl/Cmd + +)'
          style={{ borderRadius: '9999px' }}
        >
          <Plus size={16} className='text-gray-600 dark:text-gray-300' />
        </Button>
        <div className='mx-0.5 h-4 w-px bg-gray-300/60 dark:bg-white/10' />
        <Button
          onClick={handleResetClick}
          variant='ghost'
          size='1'
          title='Fit to viewport (Ctrl/Cmd + 0)'
          style={{ borderRadius: '9999px' }}
        >
          <Maximize2 size={16} className='text-gray-600 dark:text-gray-300' />
        </Button>
      </div>
    </div>
  )
}

export default ScaleControl
