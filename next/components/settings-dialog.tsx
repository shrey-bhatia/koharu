'use client'

import { useState } from 'react'
import { Dialog, Button, TextField, Text, Callout, Select } from '@radix-ui/themes'
import { Settings, CheckCircle, XCircle } from 'lucide-react'
import { useEditorStore } from '@/lib/state'
import { testApiKey } from '@/utils/translation'
import { invoke } from '@tauri-apps/api/core'

export default function SettingsDialog() {
  const { translationApiKey, setTranslationApiKey, gpuPreference, setGpuPreference } = useEditorStore()
  const [open, setOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState(translationApiKey || '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null)
  const [testMessage, setTestMessage] = useState('')
  const [gpuChanged, setGpuChanged] = useState(false)

  const handleTest = async () => {
    if (!apiKeyInput || apiKeyInput.trim().length === 0) {
      setTestResult('error')
      setTestMessage('Please enter an API key first')
      return
    }

    setTesting(true)
    setTestResult(null)
    setTestMessage('')

    try {
      const isValid = await testApiKey(apiKeyInput.trim())
      if (isValid) {
        setTestResult('success')
        setTestMessage('API key is valid! ✓')
      } else {
        setTestResult('error')
        setTestMessage('API key is invalid or has insufficient permissions')
      }
    } catch (err) {
      setTestResult('error')
      setTestMessage(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    const trimmedKey = apiKeyInput.trim()
    setTranslationApiKey(trimmedKey || null)
    setOpen(false)
    setTestResult(null)
    setTestMessage('')
  }

  const handleCancel = () => {
    setApiKeyInput(translationApiKey || '')
    setOpen(false)
    setTestResult(null)
    setTestMessage('')
  }

  const handleClear = () => {
    setApiKeyInput('')
    setTranslationApiKey(null)
    setTestResult(null)
    setTestMessage('')
  }

  const handleGpuChange = async (value: 'cuda' | 'directml' | 'cpu') => {
    setGpuPreference(value)
    setGpuChanged(true)

    // Save to backend config file
    try {
      await invoke('set_gpu_preference', { preference: value })
      console.log(`GPU preference set to ${value}. Restart required.`)
    } catch (err) {
      console.error('Failed to save GPU preference:', err)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant='soft' size='2'>
          <Settings className='h-4 w-4' />
        </Button>
      </Dialog.Trigger>

      <Dialog.Content maxWidth='450px'>
        <Dialog.Title>Translation Settings</Dialog.Title>
        <Dialog.Description size='2' mb='4'>
          Configure your Google Cloud Translation API key for automatic manga translation.
        </Dialog.Description>

        <div className='space-y-4'>
          <div className='space-y-2'>
            <label>
              <Text as='div' size='2' mb='1' weight='bold'>
                API Key
              </Text>
              <TextField.Root
                type='password'
                placeholder='Enter your Google Cloud API key'
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleTest()
                  }
                }}
              />
            </label>

            <div className='flex gap-2'>
              <Button
                size='1'
                variant='soft'
                onClick={handleTest}
                disabled={testing || !apiKeyInput}
                loading={testing}
              >
                Test Connection
              </Button>
              {apiKeyInput && (
                <Button size='1' variant='soft' color='red' onClick={handleClear}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <Callout.Root color={testResult === 'success' ? 'green' : 'red'} size='1'>
              <Callout.Icon>
                {testResult === 'success' ? (
                  <CheckCircle className='h-4 w-4' />
                ) : (
                  <XCircle className='h-4 w-4' />
                )}
              </Callout.Icon>
              <Callout.Text>{testMessage}</Callout.Text>
            </Callout.Root>
          )}

          {/* Instructions */}
          <div className='rounded border border-gray-200 bg-gray-50 p-3'>
            <Text size='1' className='text-gray-700'>
              <strong>How to get an API key:</strong>
              <ol className='ml-4 mt-2 list-decimal space-y-1'>
                <li>Go to Google Cloud Console</li>
                <li>Enable Cloud Translation API</li>
                <li>Create credentials → API Key</li>
                <li>Copy and paste the key above</li>
              </ol>
              <div className='mt-2'>
                <strong>Free tier:</strong> 500,000 characters/month
              </div>
            </Text>
          </div>

          {/* GPU Preference */}
          <div className='space-y-2'>
            <label>
              <Text as='div' size='2' mb='1' weight='bold'>
                GPU Preference
              </Text>
              <Select.Root
                value={gpuPreference}
                onValueChange={handleGpuChange}
              >
                <Select.Trigger className='w-full' />
                <Select.Content>
                  <Select.Item value='cuda'>
                    <div className='flex flex-col'>
                      <span className='font-medium'>NVIDIA CUDA (Best Performance)</span>
                      <span className='text-xs text-gray-500'>Requires NVIDIA GPU with CUDA support</span>
                    </div>
                  </Select.Item>
                  <Select.Item value='directml'>
                    <div className='flex flex-col'>
                      <span className='font-medium'>DirectML (Intel/AMD GPU)</span>
                      <span className='text-xs text-gray-500'>Uses integrated or AMD graphics</span>
                    </div>
                  </Select.Item>
                  <Select.Item value='cpu'>
                    <div className='flex flex-col'>
                      <span className='font-medium'>CPU Only (Slowest)</span>
                      <span className='text-xs text-gray-500'>Fallback option, very slow</span>
                    </div>
                  </Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
          </div>

          {/* GPU change warning */}
          {gpuChanged && (
            <Callout.Root color='yellow' size='1'>
              <Callout.Text>
                <strong>Restart Required:</strong> GPU preference will apply after restarting the application.
              </Callout.Text>
            </Callout.Root>
          )}

          {/* Security notice */}
          <Callout.Root size='1'>
            <Callout.Text>
              <strong>Note:</strong> Your API key is stored locally in your browser and never sent
              anywhere except Google Translation API.
            </Callout.Text>
          </Callout.Root>
        </div>

        <div className='mt-6 flex justify-end gap-3'>
          <Dialog.Close>
            <Button variant='soft' color='gray' onClick={handleCancel}>
              Cancel
            </Button>
          </Dialog.Close>
          <Dialog.Close>
            <Button onClick={handleSave}>Save</Button>
          </Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}
