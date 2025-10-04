'use client'

import { Badge, Button, Callout, Text, Progress, Code } from '@radix-ui/themes'
import { CheckCircle, XCircle, AlertTriangle, Zap, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useState, useEffect } from 'react'

interface GpuInitResult {
  requested_provider: string
  available_providers: string[]
  active_provider: string
  device_id: number
  device_name: string | null
  success: boolean
  warmup_time_ms: number
}

interface StressTestResult {
  timings_ms: number[]
  avg_ms: number
  min_ms: number
  max_ms: number
  target_size: number
  iterations: number
}

export default function GpuStatusPanel() {
  const [status, setStatus] = useState<GpuInitResult | null>(null)
  const [stressTest, setStressTest] = useState<StressTestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadStatus()
  }, [])

  const loadStatus = async () => {
    try {
      const result = await invoke<GpuInitResult>('get_current_gpu_status')
      setStatus(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GPU status')
    }
  }

  const runStressTest = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await invoke<StressTestResult>('run_gpu_stress_test', {
        iterations: 5,
        targetSize: 768,
      })
      setStressTest(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stress test failed')
    } finally {
      setLoading(false)
    }
  }

  if (error && !status) {
    return (
      <Callout.Root color='red' size='1'>
        <Callout.Icon>
          <XCircle className='h-4 w-4' />
        </Callout.Icon>
        <Callout.Text>{error}</Callout.Text>
      </Callout.Root>
    )
  }

  if (!status) return null

  const isGpuAccelerated = status.success && status.warmup_time_ms < 1000
  const hasFallback = status.active_provider.includes('fallback')

  return (
    <div className='rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <h3 className='font-semibold dark:text-white'>GPU Status</h3>
          {isGpuAccelerated && !hasFallback ? (
            <CheckCircle className='h-5 w-5 text-green-600' />
          ) : (
            <XCircle className='h-5 w-5 text-red-600' />
          )}
        </div>
        <Button size='1' variant='ghost' onClick={loadStatus}>
          <RefreshCw className='h-3 w-3' />
        </Button>
      </div>

      {/* Main Status */}
      <div className='mt-3 space-y-3'>
        {/* Active Provider */}
        <div className='flex items-center justify-between'>
          <Text className='text-sm text-gray-600 dark:text-gray-400'>Provider:</Text>
          <Badge
            color={isGpuAccelerated && !hasFallback ? 'green' : 'red'}
            size='2'
            className='font-mono'
          >
            {status.active_provider}
          </Badge>
        </div>

        {/* Device Name */}
        {status.device_name && (
          <div className='flex items-center justify-between'>
            <Text className='text-sm text-gray-600 dark:text-gray-400'>Device:</Text>
            <Text className='text-sm font-mono dark:text-white'>{status.device_name}</Text>
          </div>
        )}

        {/* Warmup Latency */}
        <div className='flex items-center justify-between'>
          <Text className='text-sm text-gray-600 dark:text-gray-400'>Warmup:</Text>
          <div className='flex items-center gap-2'>
            <Code className={isGpuAccelerated ? 'text-green-600' : 'text-red-600'}>
              {status.warmup_time_ms}ms
            </Code>
            {isGpuAccelerated ? (
              <Zap className='h-4 w-4 text-green-600' aria-label='Fast (GPU accelerated)' />
            ) : (
              <AlertTriangle className='h-4 w-4 text-red-600' aria-label='Slow (possible CPU fallback)' />
            )}
          </div>
        </div>

        {/* Available Providers (collapsible) */}
        <details className='text-xs'>
          <summary className='cursor-pointer text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'>
            Available Providers ({status.available_providers.length})
          </summary>
          <ul className='ml-4 mt-2 list-disc space-y-1'>
            {status.available_providers.map((p, i) => (
              <li key={i} className='font-mono'>
                {p}
                {p === status.requested_provider && ' (requested)'}
              </li>
            ))}
          </ul>
        </details>

        {/* Warning for CPU fallback */}
        {hasFallback && (
          <Callout.Root color='yellow' size='1' className='mt-2'>
            <Callout.Icon>
              <AlertTriangle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>
              <strong>Warning:</strong> GPU acceleration may not be working properly.
              Inpainting will be significantly slower (~10-20x). Check your GPU drivers
              and CUDA/DirectML installation.
            </Callout.Text>
          </Callout.Root>
        )}

        {!isGpuAccelerated && !hasFallback && status.requested_provider !== 'cpu' && (
          <Callout.Root color='red' size='1' className='mt-2'>
            <Callout.Icon>
              <XCircle className='h-4 w-4' />
            </Callout.Icon>
            <Callout.Text>
              <strong>GPU acceleration failed.</strong> Warmup took {status.warmup_time_ms}ms
              (expected &lt;800ms for CUDA). This indicates the GPU is not being used.
              <br />
              <strong>Solutions:</strong>
              <ul className='ml-4 mt-1 list-disc'>
                <li>Ensure NVIDIA drivers are up to date</li>
                <li>Verify CUDA 12.9 and cuDNN 9.11 are installed</li>
                <li>Check that CUDA bin directories are in PATH</li>
                <li>Restart the application after fixing</li>
              </ul>
            </Callout.Text>
          </Callout.Root>
        )}

        {/* Stress Test */}
        <div className='mt-4 space-y-2 border-t pt-3 dark:border-gray-700'>
          <div className='flex items-center justify-between'>
            <Text className='text-sm font-semibold dark:text-white'>Stress Test</Text>
            <Button onClick={runStressTest} loading={loading} size='1' variant='soft'>
              <Zap className='h-4 w-4' />
              Run 5× 768px
            </Button>
          </div>

          {stressTest && (
            <div className='space-y-2 rounded bg-gray-50 p-3 dark:bg-gray-900'>
              <div className='grid grid-cols-3 gap-2 text-xs'>
                <div>
                  <Text className='text-gray-600 dark:text-gray-400'>Avg:</Text>
                  <Code className='ml-1'>{stressTest.avg_ms}ms</Code>
                </div>
                <div>
                  <Text className='text-gray-600 dark:text-gray-400'>Min:</Text>
                  <Code className='ml-1'>{stressTest.min_ms}ms</Code>
                </div>
                <div>
                  <Text className='text-gray-600 dark:text-gray-400'>Max:</Text>
                  <Code className='ml-1'>{stressTest.max_ms}ms</Code>
                </div>
              </div>

              {/* Visual timing chart */}
              <div className='flex h-12 items-end gap-1'>
                {stressTest.timings_ms.map((t, i) => {
                  const maxTime = Math.max(...stressTest.timings_ms)
                  const heightPercent = (t / maxTime) * 100
                  return (
                    <div
                      key={i}
                      className='flex-1 rounded-t bg-green-500 dark:bg-green-600'
                      style={{ height: `${heightPercent}%` }}
                      title={`Iteration ${i + 1}: ${t}ms`}
                    />
                  )
                })}
              </div>

              {/* Performance verdict */}
              <div className='text-xs'>
                {stressTest.avg_ms < 500 && (
                  <Badge color='green'>
                    ✓ Excellent performance (CUDA verified)
                  </Badge>
                )}
                {stressTest.avg_ms >= 500 && stressTest.avg_ms < 1000 && (
                  <Badge color='blue'>
                    ✓ Good performance (GPU accelerated)
                  </Badge>
                )}
                {stressTest.avg_ms >= 1000 && stressTest.avg_ms < 3000 && (
                  <Badge color='yellow'>
                    ⚠ Slow (DirectML or weak GPU)
                  </Badge>
                )}
                {stressTest.avg_ms >= 3000 && (
                  <Badge color='red'>
                    ✗ Very slow (CPU fallback detected)
                  </Badge>
                )}
              </div>
            </div>
          )}

          {error && (
            <Text className='text-xs text-red-600 dark:text-red-400'>
              Stress test failed: {error}
            </Text>
          )}
        </div>

        {/* Interpretation Guide */}
        <details className='text-xs text-gray-600 dark:text-gray-400'>
          <summary className='cursor-pointer hover:text-gray-800 dark:hover:text-gray-200'>
            Performance Expectations
          </summary>
          <ul className='ml-4 mt-2 list-disc space-y-1'>
            <li><strong>CUDA (NVIDIA):</strong> 200-500ms per 768px inference</li>
            <li><strong>DirectML (AMD/Intel):</strong> 500-1200ms per 768px inference</li>
            <li><strong>CPU:</strong> 3000-8000ms per 768px inference (not recommended)</li>
          </ul>
        </details>
      </div>
    </div>
  )
}
