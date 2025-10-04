'use client'

import { Button, Select, Text, Badge, Callout, Slider } from '@radix-ui/themes'
import { Settings2, Info } from 'lucide-react'
import { useEditorStore, INPAINTING_PRESETS } from '@/lib/state'
import { useState } from 'react'

export default function InpaintSettings() {
  const { inpaintingConfig, inpaintingPreset, setInpaintingPreset, setInpaintingConfig } = useEditorStore()
  const [showAdvanced, setShowAdvanced] = useState(false)

  return (
    <div className='space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Settings2 className='h-5 w-5 dark:text-white' />
          <h3 className='font-semibold dark:text-white'>Inpainting Quality</h3>
        </div>
        {inpaintingPreset === 'custom' && (
          <Badge color='purple' size='1'>Custom</Badge>
        )}
      </div>

      {/* Preset Selector */}
      <div className='space-y-2'>
        <label className='text-sm font-semibold dark:text-white'>Preset</label>
        <div className='grid grid-cols-3 gap-2'>
          {(['fast', 'balanced', 'quality'] as const).map((preset) => (
            <Button
              key={preset}
              variant={inpaintingPreset === preset ? 'solid' : 'soft'}
              onClick={() => setInpaintingPreset(preset)}
              className='capitalize'
              size='2'
            >
              {preset}
            </Button>
          ))}
        </div>
      </div>

      {/* Preset Description */}
      <Callout.Root size='1' color='blue'>
        <Callout.Icon><Info className='h-4 w-4' /></Callout.Icon>
        <Callout.Text>
          {inpaintingPreset === 'fast' && (
            <>
              <strong>Fast:</strong> Small padding (30px), 384px resolution, minimal processing.
              Best for clean speech bubbles. ~3-5 sec/block.
            </>
          )}
          {inpaintingPreset === 'balanced' && (
            <>
              <strong>Balanced:</strong> Medium padding (50px), 512px resolution, auto blending.
              Good default for most pages. ~5-8 sec/block.
            </>
          )}
          {inpaintingPreset === 'quality' && (
            <>
              <strong>Quality:</strong> Large padding (80px), 768px resolution, seamless blending.
              Preserves screentones & gradients. ~12-15 sec/block.
            </>
          )}
          {inpaintingPreset === 'custom' && (
            <>
              <strong>Custom:</strong> You have manually adjusted settings below.
            </>
          )}
        </Callout.Text>
      </Callout.Root>

      {/* Advanced Toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className='text-sm text-blue-600 hover:underline dark:text-blue-400'
      >
        {showAdvanced ? '▼' : '▶'} Advanced Settings
      </button>

      {/* Advanced Controls */}
      {showAdvanced && (
        <div className='space-y-4 border-t pt-4 dark:border-gray-700'>
          {/* Context Padding */}
          <div className='space-y-2'>
            <label className='flex items-center justify-between text-xs font-medium text-gray-600 dark:text-gray-400'>
              <span>Context Padding</span>
              <span className='font-mono'>{inpaintingConfig.padding}px</span>
            </label>
            <Slider
              value={[inpaintingConfig.padding]}
              onValueChange={([v]) => setInpaintingConfig({ padding: v })}
              min={0}
              max={100}
              step={1}
            />
            <Text size='1' color='gray'>Extra context around text. 0px = tight crop, higher = more context.</Text>
          </div>

          {/* Note: Target Resolution removed - LaMa model only supports 512px */}

          {/* Mask Erosion */}
          <div className='space-y-2'>
            <label className='flex items-center justify-between text-xs font-medium text-gray-600 dark:text-gray-400'>
              <span>Mask Erosion</span>
              <span className='font-mono'>{inpaintingConfig.maskErosion}px</span>
            </label>
            <Slider
              value={[inpaintingConfig.maskErosion]}
              onValueChange={([v]) => setInpaintingConfig({ maskErosion: v })}
              min={0}
              max={10}
              step={1}
            />
            <Text size='1' color='gray'>Shrinks mask to prevent white halos at edges</Text>
          </div>

          {/* Mask Threshold */}
          <div className='space-y-2'>
            <label className='flex items-center justify-between text-xs font-medium text-gray-600 dark:text-gray-400'>
              <span>Mask Threshold</span>
              <span className='font-mono'>{inpaintingConfig.maskThreshold}</span>
            </label>
            <Slider
              value={[inpaintingConfig.maskThreshold]}
              onValueChange={([v]) => setInpaintingConfig({ maskThreshold: v })}
              min={20}
              max={50}
              step={1}
            />
            <Text size='1' color='gray'>Lower = includes more pixels as "text"</Text>
          </div>

          {/* Feather Radius */}
          <div className='space-y-2'>
            <label className='flex items-center justify-between text-xs font-medium text-gray-600 dark:text-gray-400'>
              <span>Feather Radius</span>
              <span className='font-mono'>{inpaintingConfig.featherRadius}px</span>
            </label>
            <Slider
              value={[inpaintingConfig.featherRadius]}
              onValueChange={([v]) => setInpaintingConfig({ featherRadius: v })}
              min={0}
              max={15}
              step={1}
            />
            <Text size='1' color='gray'>Smooths edges for seamless blend</Text>
          </div>

          {/* Blending Method */}
          <div className='space-y-2'>
            <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
              Blending Method
            </label>
            <Select.Root
              value={inpaintingConfig.blendingMethod}
              onValueChange={(v: 'alpha' | 'seamless' | 'auto') =>
                setInpaintingConfig({ blendingMethod: v })
              }
            >
              <Select.Trigger className='w-full' />
              <Select.Content>
                <Select.Item value='alpha'>
                  <div className='flex flex-col'>
                    <span className='font-medium'>Alpha Only (Fast)</span>
                    <span className='text-xs text-gray-500'>Simple transparency blend</span>
                  </div>
                </Select.Item>
                <Select.Item value='auto'>
                  <div className='flex flex-col'>
                    <span className='font-medium'>Auto (Smart)</span>
                    <span className='text-xs text-gray-500'>Detects when seamless is needed</span>
                  </div>
                </Select.Item>
                <Select.Item value='seamless'>
                  <div className='flex flex-col'>
                    <span className='font-medium'>Seamless Clone (Best)</span>
                    <span className='text-xs text-gray-500'>Poisson blending for gradients</span>
                  </div>
                </Select.Item>
              </Select.Content>
            </Select.Root>
            <Text size='1' color='gray'>Seamless = better for patterned backgrounds</Text>
          </div>

          {/* Mask Dilation (Expert) */}
          <details className='text-sm'>
            <summary className='cursor-pointer text-xs font-semibold text-gray-700 dark:text-gray-300'>
              Expert Options
            </summary>
            <div className='mt-2 space-y-3'>
              {/* Dilation */}
              <div className='space-y-2'>
                <label className='flex items-center justify-between text-xs font-medium text-gray-600 dark:text-gray-400'>
                  <span>Mask Dilation</span>
                  <span className='font-mono'>{inpaintingConfig.maskDilation}px</span>
                </label>
                <Slider
                  value={[inpaintingConfig.maskDilation]}
                  onValueChange={([v]) => setInpaintingConfig({ maskDilation: v })}
                  min={0}
                  max={5}
                  step={1}
                />
                <Text size='1' color='gray'>Fills gaps in thin strokes (rare)</Text>
              </div>

              {/* Debug Toggles */}
              <div className='flex items-center justify-between'>
                <label className='text-xs font-medium text-gray-600 dark:text-gray-400'>
                  Export Triptychs
                </label>
                <input
                  type='checkbox'
                  checked={inpaintingConfig.exportTriptychs}
                  onChange={(e) => setInpaintingConfig({ exportTriptychs: e.target.checked })}
                  className='rounded'
                />
              </div>
              {inpaintingConfig.exportTriptychs && (
                <Text size='1' color='gray'>
                  Saves crop/mask/result images to app cache for debugging
                </Text>
              )}
            </div>
          </details>

          {/* Reset to Preset */}
          <Button
            variant='soft'
            color='gray'
            size='1'
            onClick={() => setInpaintingPreset('balanced')}
            className='w-full'
          >
            Reset to Balanced
          </Button>
        </div>
      )}
    </div>
  )
}
