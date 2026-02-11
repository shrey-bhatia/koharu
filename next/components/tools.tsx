'use client'

import {
  Languages,
  MessageCircle,
  PaintbrushVertical,
  Type,
} from 'lucide-react'
import { IconButton } from '@radix-ui/themes'
import { useEditorStore } from '@/lib/state'

function Tools() {
  const { tool: selectedTool, setTool: setSelectedTool } = useEditorStore()

  const tools: { id: 'detection' | 'translation' | 'inpaint' | 'render' | 'segmentation'; icon: typeof MessageCircle; description: string }[] = [
    {
      id: 'detection',
      icon: MessageCircle,
      description: 'Detect text blocks in the image',
    },
    {
      id: 'inpaint',
      icon: PaintbrushVertical,
      description: 'Inpaint text blocks',
    },
    {
      id: 'translation',
      icon: Languages,
      description: 'Translate text blocks',
    },
    {
      id: 'render',
      icon: Type,
      description: 'Render translated text',
    },
  ]

  return (
    <div className='glass-subtle flex w-20 flex-col items-center rounded-2xl border border-gray-200/60 bg-white/70 px-3 py-3 shadow-sm dark:border-white/[.06] dark:bg-gray-900/50'>
      {tools.map((tool) => {
        const isActive = selectedTool === tool.id
        return (
          <div className='group relative my-1.5' key={tool.id}>
            <div
              className={`absolute -left-1.5 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full transition-all duration-200 ${
                isActive
                  ? 'scale-100 bg-indigo-500 opacity-100'
                  : 'scale-75 bg-transparent opacity-0 group-hover:scale-100 group-hover:bg-gray-300 group-hover:opacity-60 dark:group-hover:bg-gray-500'
              }`}
            />
            <IconButton
              size='3'
              onClick={() => setSelectedTool(tool.id)}
              title={`${tool.id}: ${tool.description}`}
              variant={isActive ? 'solid' : 'ghost'}
              color={isActive ? 'indigo' : undefined}
              style={{ borderRadius: 12 }}
            >
              <tool.icon size={20} />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}

export default Tools
