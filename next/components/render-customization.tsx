'use client'

import { Select, Text } from '@radix-ui/themes'
import { useEditorStore, RGB } from '@/lib/state'
import { rgbToHex, hexToRgb } from '@/utils/color-extraction'

// Common web-safe fonts
const FONT_OPTIONS = [
  { value: 'Arial', label: 'Arial', preview: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica', preview: 'Helvetica' },
  { value: 'Times New Roman', label: 'Times New Roman', preview: 'serif' },
  { value: 'Georgia', label: 'Georgia', preview: 'Georgia' },
  { value: 'Verdana', label: 'Verdana', preview: 'Verdana' },
  { value: 'Courier New', label: 'Courier New', preview: 'monospace' },
  { value: 'Comic Sans MS', label: 'Comic Sans MS', preview: 'cursive' },
  { value: 'Impact', label: 'Impact', preview: 'Impact' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS', preview: 'sans-serif' },
  { value: 'Tahoma', label: 'Tahoma', preview: 'Tahoma' },
]

interface RenderCustomizationProps {
  blockIndex: number
  onReProcess?: () => void
}

export default function RenderCustomization({ blockIndex, onReProcess }: RenderCustomizationProps) {
  const { textBlocks, setTextBlocks } = useEditorStore()
  const block = textBlocks[blockIndex]

  const updateBlock = (updates: Partial<typeof block>) => {
    const updated = [...textBlocks]
    updated[blockIndex] = { ...updated[blockIndex], ...updates }
    setTextBlocks(updated)
  }

  const bgColor = block.manualBgColor || block.backgroundColor || { r: 255, g: 255, b: 255 }
  const textColor = block.manualTextColor || block.textColor || { r: 0, g: 0, b: 0 }

  return (
    <div className='space-y-3 p-3 border-t border-gray-200 dark:border-gray-700'>
      <Text className='text-sm font-semibold dark:text-white'>Customize Block #{blockIndex + 1}</Text>

      {/* Background Color */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Background Color
        </label>
        <div className='flex items-center gap-2'>
          <input
            type='color'
            value={rgbToHex(bgColor)}
            onChange={(e) => updateBlock({ manualBgColor: hexToRgb(e.target.value) })}
            className='h-8 w-12 cursor-pointer rounded border border-gray-300 dark:border-gray-600'
          />
          <Text className='text-xs text-gray-600 dark:text-gray-400'>
            rgb({bgColor.r}, {bgColor.g}, {bgColor.b})
          </Text>
          {block.manualBgColor && (
            <button
              onClick={() => updateBlock({ manualBgColor: undefined })}
              className='text-xs text-blue-600 hover:underline dark:text-blue-400'
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Text Color */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Text Color
        </label>
        <div className='flex items-center gap-2'>
          <input
            type='color'
            value={rgbToHex(textColor)}
            onChange={(e) => updateBlock({ manualTextColor: hexToRgb(e.target.value) })}
            className='h-8 w-12 cursor-pointer rounded border border-gray-300 dark:border-gray-600'
          />
          <Text className='text-xs text-gray-600 dark:text-gray-400'>
            rgb({textColor.r}, {textColor.g}, {textColor.b})
          </Text>
          {block.manualTextColor && (
            <button
              onClick={() => updateBlock({ manualTextColor: undefined })}
              className='text-xs text-blue-600 hover:underline dark:text-blue-400'
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Font Size */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Font Size: {block.fontSize || 16}px
        </label>
        <input
          type='range'
          min='8'
          max='72'
          value={block.fontSize || 16}
          onChange={(e) => updateBlock({ fontSize: parseInt(e.target.value) })}
          className='w-full'
        />
      </div>

      {/* Font Family - Simple dropdown for now */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Font Family
        </label>
        <select
          value={block.fontFamily || 'Arial'}
          onChange={(e) => updateBlock({ fontFamily: e.target.value })}
          className='w-full rounded border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white'
          style={{ fontFamily: block.fontFamily || 'Arial' }}
        >
          {FONT_OPTIONS.map((font) => (
            <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>
              {font.label}
            </option>
          ))}
        </select>
        <div
          className='mt-1 rounded border border-gray-200 p-2 text-center dark:border-gray-600 dark:bg-gray-700'
          style={{ fontFamily: block.fontFamily || 'Arial', fontSize: block.fontSize || 16 }}
        >
          <Text className='dark:text-white'>Preview: {block.translatedText || 'Sample text'}</Text>
        </div>
      </div>
    </div>
  )
}
