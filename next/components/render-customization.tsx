'use client'

import { Select, Text, Badge } from '@radix-ui/themes'
import { useEditorStore, RGB } from '@/lib/state'
import { rgbToHex, hexToRgb } from '@/utils/color-extraction'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CheckCircle, AlertTriangle } from 'lucide-react'

// Fallback fonts if system fonts fail to load
const FALLBACK_FONTS = [
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Georgia',
  'Verdana',
  'Courier New',
  'Comic Sans MS',
  'Impact',
  'Trebuchet MS',
  'Tahoma',
]

interface RenderCustomizationProps {
  blockIndex: number
  onReProcess?: () => void
}

export default function RenderCustomization({ blockIndex, onReProcess }: RenderCustomizationProps) {
  const { textBlocks, setTextBlocks } = useEditorStore()
  const block = textBlocks[blockIndex]
  const [systemFonts, setSystemFonts] = useState<string[]>(FALLBACK_FONTS)
  const [loadingFonts, setLoadingFonts] = useState(true)

  // Fetch system fonts on mount
  useEffect(() => {
    const fetchFonts = async () => {
      try {
        const fonts = await invoke<string[]>('get_system_fonts')
        setSystemFonts(fonts)
      } catch (error) {
        console.error('Failed to load system fonts, using fallback:', error)
        setSystemFonts(FALLBACK_FONTS)
      } finally {
        setLoadingFonts(false)
      }
    }
    fetchFonts()
  }, [])

  const updateBlock = (updates: Partial<typeof block>) => {
    const updated = [...textBlocks]
    updated[blockIndex] = { ...updated[blockIndex], ...updates }
    setTextBlocks(updated)
  }

  const bgColor = block.manualBgColor || block.backgroundColor || { r: 255, g: 255, b: 255 }
  const textColor = block.manualTextColor || block.textColor || { r: 0, g: 0, b: 0 }

  // Appearance confidence
  const hasAppearance = block.appearance
  const confidence = block.appearance?.confidence || 0
  const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx

  return (
    <div className='space-y-3 p-3 border-t border-gray-200 dark:border-gray-700'>
      <div className='flex items-center justify-between'>
        <Text className='text-sm font-semibold dark:text-white'>Customize Block #{blockIndex + 1}</Text>
        {hasAppearance && (
          <div className='flex items-center gap-1'>
            {confidence > 0.7 ? (
              <Badge color='green' size='1'>
                <CheckCircle className='h-3 w-3' />
                High Confidence
              </Badge>
            ) : confidence > 0.5 ? (
              <Badge color='blue' size='1'>
                <AlertTriangle className='h-3 w-3' />
                Medium
              </Badge>
            ) : (
              <Badge color='yellow' size='1'>
                <AlertTriangle className='h-3 w-3' />
                Low Confidence
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Appearance Analysis Info */}
      {hasAppearance && (
        <div className='rounded-md border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-800 dark:bg-blue-950'>
          <Text className='font-semibold text-blue-900 dark:text-blue-100'>
            Appearance Analysis
          </Text>
          <ul className='ml-4 mt-1 list-disc space-y-1 text-blue-800 dark:text-blue-200'>
            <li>Confidence: {(confidence * 100).toFixed(0)}%</li>
            {hasOutline && (
              <li>Outline detected: {block.appearance.outlineWidthPx}px stroke</li>
            )}
            {block.maskStats && (
              <li>
                Orientation: {block.maskStats.orientationDeg.toFixed(1)}°,
                Eccentricity: {block.maskStats.eccentricity.toFixed(2)}
              </li>
            )}
          </ul>
        </div>
      )}

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

      {/* Letter Spacing */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Letter Spacing: {block.letterSpacing || 0}px
        </label>
        <input
          type='range'
          min='-5'
          max='20'
          step='0.5'
          value={block.letterSpacing || 0}
          onChange={(e) => updateBlock({ letterSpacing: parseFloat(e.target.value) })}
          className='w-full'
        />
      </div>

      {/* Font Weight */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Font Weight
        </label>
        <select
          value={block.fontWeight || 'normal'}
          onChange={(e) => {
            const val = e.target.value
            updateBlock({ fontWeight: val === 'normal' || val === 'bold' ? val : parseInt(val) })
          }}
          className='w-full rounded border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white'
        >
          <option value='normal'>Normal (400)</option>
          <option value='bold'>Bold (700)</option>
          <option value='100'>Thin (100)</option>
          <option value='300'>Light (300)</option>
          <option value='500'>Medium (500)</option>
          <option value='600'>Semi-Bold (600)</option>
          <option value='800'>Extra-Bold (800)</option>
          <option value='900'>Black (900)</option>
        </select>
      </div>

      {/* Font Stretch */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Font Stretch
        </label>
        <select
          value={block.fontStretch || 'normal'}
          onChange={(e) => updateBlock({ fontStretch: e.target.value as 'normal' | 'condensed' | 'expanded' })}
          className='w-full rounded border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white'
        >
          <option value='normal'>Normal</option>
          <option value='condensed'>Condensed</option>
          <option value='expanded'>Expanded</option>
        </select>
      </div>

      {/* Font Family */}
      <div className='space-y-1'>
        <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
          Font Family {loadingFonts && '(Loading...)'}
        </label>
        <select
          value={block.fontFamily || 'Arial'}
          onChange={(e) => updateBlock({ fontFamily: e.target.value })}
          className='w-full rounded border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white'
          style={{ fontFamily: block.fontFamily || 'Arial' }}
          disabled={loadingFonts}
        >
          {systemFonts.map((font) => (
            <option key={font} value={font} style={{ fontFamily: font }}>
              {font}
            </option>
          ))}
        </select>
        <div
          className='mt-1 rounded border border-gray-200 p-2 text-center dark:border-gray-600 dark:bg-gray-700'
          style={{
            fontFamily: block.fontFamily || 'Arial',
            fontSize: block.fontSize || 16,
            letterSpacing: `${block.letterSpacing || 0}px`,
            fontWeight: block.fontWeight || 'normal',
            fontStretch: block.fontStretch || 'normal',
          }}
        >
          <Text className='dark:text-white'>Preview: {block.translatedText || 'Sample text'}</Text>
        </div>
      </div>
    </div>
  )
}
