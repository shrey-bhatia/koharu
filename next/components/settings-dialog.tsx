'use client'

import { useState, useEffect } from 'react'
import { Dialog, Button, TextField, Text, Callout, Select, Tabs } from '@radix-ui/themes'
import { Settings, CheckCircle, XCircle } from 'lucide-react'
import { useEditorStore } from '@/lib/state'
import { testApiKey, TranslationProvider } from '@/utils/translation'
import { invoke } from '@tauri-apps/api/core'
import GpuStatusPanel from './gpu-status-panel'

export default function SettingsDialog() {
  const {
    translationApiKey,
    setTranslationApiKey,
    deeplApiKey,
    setDeeplApiKey,
    translationProvider,
    setTranslationProvider,
    gpuPreference,
    setGpuPreference,
    defaultFont,
    setDefaultFont
  } = useEditorStore()
  const [open, setOpen] = useState(false)
  const [googleApiKeyInput, setGoogleApiKeyInput] = useState(translationApiKey || '')
  const [deeplApiKeyInput, setDeeplApiKeyInput] = useState(deeplApiKey || '')
  const [selectedProvider, setSelectedProvider] = useState<TranslationProvider>(translationProvider)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null)
  const [testMessage, setTestMessage] = useState('')
  const [gpuChanged, setGpuChanged] = useState(false)
  const [systemFonts, setSystemFonts] = useState<string[]>(['Arial'])
  const [loadingFonts, setLoadingFonts] = useState(true)

  const handleTest = async () => {
    const currentApiKey = selectedProvider === 'google' ? googleApiKeyInput : deeplApiKeyInput

    if (!currentApiKey || currentApiKey.trim().length === 0) {
      setTestResult('error')
      setTestMessage('Please enter an API key first')
      return
    }

    setTesting(true)
    setTestResult(null)
    setTestMessage('')

    try {
      const isValid = await testApiKey(currentApiKey.trim(), selectedProvider)
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
    const trimmedGoogleKey = googleApiKeyInput.trim()
    const trimmedDeeplKey = deeplApiKeyInput.trim()

    setTranslationApiKey(trimmedGoogleKey || null)
    setDeeplApiKey(trimmedDeeplKey || null)
    setTranslationProvider(selectedProvider)

    setOpen(false)
    setTestResult(null)
    setTestMessage('')
  }

  const handleCancel = () => {
    setGoogleApiKeyInput(translationApiKey || '')
    setDeeplApiKeyInput(deeplApiKey || '')
    setSelectedProvider(translationProvider)
    setOpen(false)
    setTestResult(null)
    setTestMessage('')
  }

  const handleClearCurrentProvider = () => {
    if (selectedProvider === 'google') {
      setGoogleApiKeyInput('')
    } else {
      setDeeplApiKeyInput('')
    }
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

  // Load system fonts when dialog opens
  useEffect(() => {
    if (!open) return

    const fetchFonts = async () => {
      try {
        const fonts = await invoke<string[]>('get_system_fonts')
        setSystemFonts(fonts)
      } catch (error) {
        console.error('Failed to load system fonts:', error)
        setSystemFonts(['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana'])
      } finally {
        setLoadingFonts(false)
      }
    }
    fetchFonts()
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant='soft' size='2'>
          <Settings className='h-4 w-4' />
        </Button>
      </Dialog.Trigger>

      <Dialog.Content maxWidth='600px'>
        <Dialog.Title>Settings</Dialog.Title>
        <Dialog.Description size='2' mb='4'>
          Configure translation API and GPU acceleration settings.
        </Dialog.Description>

        <Tabs.Root defaultValue='translation'>
          <Tabs.List>
            <Tabs.Trigger value='translation'>Translation</Tabs.Trigger>
            <Tabs.Trigger value='render'>Render/Text</Tabs.Trigger>
            <Tabs.Trigger value='gpu'>GPU & Performance</Tabs.Trigger>
          </Tabs.List>

          {/* Translation Tab */}
          <Tabs.Content value='translation'>
            <div className='mt-4 space-y-4'>
              {/* Provider Selection */}
              <div className='space-y-2'>
                <label>
                  <Text as='div' size='2' mb='1' weight='bold'>
                    Translation Provider
                  </Text>
                  <Select.Root
                    value={selectedProvider}
                    onValueChange={(value: TranslationProvider) => {
                      setSelectedProvider(value)
                      setTestResult(null)
                      setTestMessage('')
                    }}
                  >
                    <Select.Trigger className='w-full' />
                    <Select.Content>
                      <Select.Item value='google'>
                        <div className='flex flex-col'>
                          <span className='font-medium'>Google Cloud Translation</span>
                          <span className='text-xs text-gray-500'>500,000 characters/month free</span>
                        </div>
                      </Select.Item>
                      <Select.Item value='deepl-free'>
                        <div className='flex flex-col'>
                          <span className='font-medium'>DeepL Free</span>
                          <span className='text-xs text-gray-500'>500,000 characters/month free</span>
                        </div>
                      </Select.Item>
                      <Select.Item value='deepl-pro'>
                        <div className='flex flex-col'>
                          <span className='font-medium'>DeepL Pro</span>
                          <span className='text-xs text-gray-500'>Paid plan with unlimited usage</span>
                        </div>
                      </Select.Item>
                      <Select.Item value='ollama'>
                        <div className='flex flex-col'>
                          <span className='font-medium'>Ollama (Local LLM)</span>
                          <span className='text-xs text-gray-500'>Runs locally via http://localhost:11434</span>
                        </div>
                      </Select.Item>
                    </Select.Content>
                  </Select.Root>
                </label>
              </div>

              {/* API Key Input - Conditional based on provider (hidden for Ollama) */}
              {selectedProvider !== 'ollama' && (
                <div className='space-y-2'>
                  <label>
                    <Text as='div' size='2' mb='1' weight='bold'>
                      {selectedProvider === 'google' ? 'Google Cloud API Key' : 'DeepL API Key'}
                    </Text>
                    <TextField.Root
                      type='password'
                      placeholder={
                        selectedProvider === 'google'
                          ? 'Enter your Google Cloud API key'
                          : 'Enter your DeepL API key'
                      }
                      value={selectedProvider === 'google' ? googleApiKeyInput : deeplApiKeyInput}
                      onChange={(e) => {
                        if (selectedProvider === 'google') {
                          setGoogleApiKeyInput(e.target.value)
                        } else {
                          setDeeplApiKeyInput(e.target.value)
                        }
                      }}
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
                      disabled={
                        testing ||
                        (selectedProvider === 'google' ? !googleApiKeyInput : !deeplApiKeyInput)
                      }
                      loading={testing}
                    >
                      Test Connection
                    </Button>
                    {((selectedProvider === 'google' && googleApiKeyInput) ||
                      ((selectedProvider === 'deepl-free' || selectedProvider === 'deepl-pro') && deeplApiKeyInput)) && (
                      <Button size='1' variant='soft' color='red' onClick={handleClearCurrentProvider}>
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              )}

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

              {/* Instructions - Conditional based on provider */}
              <div className='rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900'>
                <Text size='1' className='text-gray-700 dark:text-gray-300'>
                  {selectedProvider === 'google' ? (
                    <>
                      <strong>How to get a Google Cloud API key:</strong>
                      <ol className='ml-4 mt-2 list-decimal space-y-1'>
                        <li>Go to Google Cloud Console</li>
                        <li>Enable Cloud Translation API</li>
                        <li>Create credentials → API Key</li>
                        <li>Copy and paste the key above</li>
                      </ol>
                      <div className='mt-2'>
                        <strong>Free tier:</strong> 500,000 characters/month
                      </div>
                    </>
                  ) : selectedProvider === 'deepl-free' ? (
                    <>
                      <strong>How to get a DeepL Free API key:</strong>
                      <ol className='ml-4 mt-2 list-decimal space-y-1'>
                        <li>Go to DeepL API website (deepl.com/pro-api)</li>
                        <li>Sign up for DeepL API Free plan</li>
                        <li>Find your API key in the account settings</li>
                        <li>Copy and paste the key above</li>
                      </ol>
                      <div className='mt-2'>
                        <strong>Free tier:</strong> 500,000 characters/month
                      </div>
                      <div className='mt-2 text-yellow-700 dark:text-yellow-500'>
                        <strong>Important:</strong> Free API keys only work with the free endpoint (api-free.deepl.com).
                      </div>
                    </>
                  ) : selectedProvider === 'deepl-pro' ? (
                    <>
                      <strong>How to get a DeepL Pro API key:</strong>
                      <ol className='ml-4 mt-2 list-decimal space-y-1'>
                        <li>Go to DeepL API website (deepl.com/pro-api)</li>
                        <li>Subscribe to DeepL API Pro plan</li>
                        <li>Find your API key in the account settings</li>
                        <li>Copy and paste the key above</li>
                      </ol>
                      <div className='mt-2'>
                        <strong>Pro plan:</strong> Pay-as-you-go pricing with higher rate limits
                      </div>
                      <div className='mt-2 text-yellow-700 dark:text-yellow-500'>
                        <strong>Important:</strong> Pro API keys only work with the pro endpoint (api.deepl.com).
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>Using Ollama for Local LLM Translation:</strong>
                      <ol className='ml-4 mt-2 list-decimal space-y-1'>
                        <li>Install Ollama from ollama.com</li>
                        <li>Start Ollama (runs on http://localhost:11434 by default)</li>
                        <li>Pull a model: <code className='rounded bg-gray-200 px-1 dark:bg-gray-800'>ollama pull gemma2:2b</code></li>
                        <li>Set your translation system prompt in Ollama</li>
                      </ol>
                      <div className='mt-2'>
                        <strong>Benefits:</strong> Free, unlimited, runs locally, no API key needed
                      </div>
                      <div className='mt-2 text-blue-700 dark:text-blue-500'>
                        <strong>Note:</strong> The OCR'd Japanese text is passed directly to your model. Configure your system prompt in Ollama beforehand.
                      </div>
                    </>
                  )}
                </Text>
              </div>

              {/* Security notice */}
              <Callout.Root size='1'>
                <Callout.Text>
                  <strong>Note:</strong> Your API keys are stored locally and only sent to their
                  respective translation services. Keys are never shared between providers.
                </Callout.Text>
              </Callout.Root>
            </div>
          </Tabs.Content>

          {/* Render/Text Tab */}
          <Tabs.Content value='render'>
            <div className='mt-4 space-y-4'>
              <div className='space-y-2'>
                <label>
                  <Text as='div' size='2' mb='1' weight='bold'>
                    Default Font
                  </Text>
                  <Select.Root
                    value={defaultFont}
                    onValueChange={setDefaultFont}
                  >
                    <Select.Trigger className='w-full' placeholder={loadingFonts ? 'Loading fonts...' : 'Select a font'} />
                    <Select.Content>
                      {systemFonts.map((font) => (
                        <Select.Item key={font} value={font}>
                          <span style={{ fontFamily: font }}>{font}</span>
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </label>
                <Text size='1' className='text-gray-600 dark:text-gray-400'>
                  This font will be used by default for all translated text. You can override it per block in the customization panel.
                </Text>
              </div>

              {/* Font Preview */}
              <div className='rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900'>
                <Text size='1' className='text-gray-600 dark:text-gray-400'>Preview:</Text>
                <div className='mt-2 text-lg' style={{ fontFamily: defaultFont }}>
                  The quick brown fox jumps over the lazy dog.
                  <br />
                  日本語のテキスト
                </div>
              </div>

              {/* Info about font availability */}
              <Callout.Root size='1'>
                <Callout.Text>
                  <strong>Note:</strong> Make sure the selected font supports the languages you're translating to.
                  Not all fonts have complete Unicode coverage.
                </Callout.Text>
              </Callout.Root>
            </div>
          </Tabs.Content>

          {/* GPU Tab */}
          <Tabs.Content value='gpu'>
            <div className='mt-4 space-y-4'>
              {/* GPU Status Panel */}
              <GpuStatusPanel />

              {/* GPU Preference Selector */}
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

              {/* Troubleshooting Guide */}
              <details className='text-sm'>
                <summary className='cursor-pointer font-semibold text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'>
                  Troubleshooting GPU Issues
                </summary>
                <div className='mt-2 space-y-2 text-xs text-gray-600 dark:text-gray-400'>
                  <div>
                    <strong>CUDA not working:</strong>
                    <ul className='ml-4 list-disc'>
                      <li>Install CUDA Toolkit 12.9 and cuDNN 9.11</li>
                      <li>Add CUDA bin directories to PATH</li>
                      <li>Update NVIDIA drivers to latest version</li>
                      <li>Restart application after installation</li>
                    </ul>
                  </div>
                  <div>
                    <strong>DirectML slow:</strong>
                    <ul className='ml-4 list-disc'>
                      <li>Ensure discrete GPU is selected (not integrated)</li>
                      <li>Update GPU drivers</li>
                      <li>Close other GPU-intensive applications</li>
                    </ul>
                  </div>
                  <div>
                    <strong>Verify GPU usage:</strong>
                    <ul className='ml-4 list-disc'>
                      <li>Run stress test above - should show &lt;800ms avg for CUDA</li>
                      <li>Check Task Manager → Performance → GPU during inpainting</li>
                      <li>Look for "possible CPU fallback" warning in status</li>
                    </ul>
                  </div>
                </div>
              </details>
            </div>
          </Tabs.Content>
        </Tabs.Root>

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
