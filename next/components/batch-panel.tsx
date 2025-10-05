'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  Flex,
  Progress,
  ScrollArea,
  Separator,
  Table,
  Text,
} from '@radix-ui/themes'
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Upload,
  ExternalLink,
} from 'lucide-react'
import { useBatchStore } from '@/lib/batch-state'
import { open as openDialog } from '@tauri-apps/api/dialog'
import { open as openPath } from '@tauri-apps/api/shell'
import type { BatchPage } from '@/lib/batch-types'

const statusColors: Record<string, 'gray' | 'green' | 'red' | 'orange' | 'amber' | 'blue'> = {
  idle: 'gray',
  ready: 'blue',
  running: 'green',
  paused: 'amber',
  cancelled: 'orange',
  completed: 'green',
  error: 'red',
}

const stageLabels: Record<string, string> = {
  pending: 'Pending',
  loading: 'Loading',
  detection: 'Detecting',
  ocr: 'OCR',
  translation: 'Translating',
  inpainting: 'Inpainting',
  coloring: 'Coloring',
  render: 'Rendering',
  saving: 'Saving',
  done: 'Done',
  failed: 'Failed',
}

const logLevelColors: Record<'info' | 'warning' | 'error', 'gray' | 'amber' | 'red'> = {
  info: 'gray',
  warning: 'amber',
  error: 'red',
}

const formatLogTimestamp = (timestamp: number) => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const formatDuration = (startedAt?: number | null, completedAt?: number | null) => {
  if (!startedAt) return '—'
  const end = completedAt ?? Date.now()
  const duration = Math.max(0, end - startedAt)
  const seconds = Math.floor(duration / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes >= 1) {
    return `${minutes}m ${remainingSeconds}s`
  }
  return `${seconds}s`
}

const isTauriEnvironment = () => {
  if (typeof window === 'undefined') return false
  return Boolean((window as unknown as { __TAURI_IPC__?: unknown }).__TAURI_IPC__)
}

const getPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value * 100)))

function BatchPanel() {
  const pages = useBatchStore((state) => state.pages)
  const status = useBatchStore((state) => state.status)
  const error = useBatchStore((state) => state.error)
  const warnings = useMemo(
    () => pages.flatMap((page) => (page.warnings ?? []).map((warning) => `${page.fileName}: ${warning}`)),
    [pages]
  )
  const addPages = useBatchStore((state) => state.addPages)
  const removePage = useBatchStore((state) => state.removePage)
  const clearPages = useBatchStore((state) => state.clearPages)
  const setOutputDir = useBatchStore((state) => state.setOutputDir)
  const outputDir = useBatchStore((state) => state.outputDir)
  const startJob = useBatchStore((state) => state.startJob)
  const pauseJob = useBatchStore((state) => state.pauseJob)
  const resumeJob = useBatchStore((state) => state.resumeJob)
  const cancelJob = useBatchStore((state) => state.cancelJob)
  const retryPage = useBatchStore((state) => state.retryPage)
  const summary = useBatchStore((state) => state.summary)
  const markError = useBatchStore((state) => state.markError)
  const clearError = useBatchStore((state) => state.clearError)

  const [busy, setBusy] = useState(false)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)

  useEffect(() => {
    if (pages.length === 0) {
      setSelectedPageId(null)
      return
    }
    if (!selectedPageId || !pages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(pages[0].id)
    }
  }, [pages, selectedPageId])

  const selectedPage = useMemo(() => pages.find((page) => page.id === selectedPageId) ?? null, [pages, selectedPageId])
  const selectedLogs = selectedPage?.logs ?? []
  const canOpenSelectedOutput = Boolean(selectedPage?.outputImagePath || selectedPage?.manifestPath)
  const canRetrySelectedPage = Boolean(selectedPage && (selectedPage.stage === 'failed' || selectedPage.stage === 'done'))

  const overallProgress = useMemo(() => {
    if (pages.length === 0) return 0
    const total = pages.reduce((acc, page) => acc + page.progress, 0)
    return Math.round((total / pages.length) * 100)
  }, [pages])

  const tauriAvailable = isTauriEnvironment()

  const handleAddImages = async () => {
    clearError()
    if (!tauriAvailable) {
      markError('Batch processing requires the desktop app (Tauri) to access image files.')
      return
    }

    try {
      setBusy(true)
      const selection = await openDialog({
        multiple: true,
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
          },
        ],
      })

      if (!selection) return

      const paths = Array.isArray(selection) ? selection : [selection]
      const sanitized = paths.filter((path): path is string => typeof path === 'string')
      if (sanitized.length === 0) return

      await addPages(sanitized)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add images'
      markError(message)
    } finally {
      setBusy(false)
    }
  }

  const handleSelectOutputDir = async () => {
    clearError()
    if (!tauriAvailable) {
      markError('Selecting an output directory requires the desktop app (Tauri).')
      return
    }

    try {
      setBusy(true)
  const selection = await openDialog({ directory: true, multiple: false })
      if (!selection) return
      if (Array.isArray(selection)) {
        setOutputDir(selection[0])
      } else {
        setOutputDir(selection)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to select output directory'
      markError(message)
    } finally {
      setBusy(false)
    }
  }

  const handleStart = async () => {
    clearError()
    setBusy(true)
    try {
      await startJob()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start batch job'
      markError(message)
    } finally {
      setBusy(false)
    }
  }

  const handlePause = () => {
    pauseJob()
  }

  const handleResume = async () => {
    setBusy(true)
    try {
      await resumeJob()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume batch job'
      markError(message)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = () => {
    cancelJob()
  }

  const handleOpenOutput = async (page: BatchPage) => {
    if (!tauriAvailable) {
      markError('Opening output requires the desktop app (Tauri).')
      return
    }

    const target = page.outputImagePath ?? page.manifestPath
    if (!target) {
      markError('No output is available for this page yet.')
      return
    }

    try {
      await openPath(target)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open output'
      markError(message)
    }
  }

  const handleRetryPage = (page: BatchPage) => {
    if (status === 'running') return
    retryPage(page.id)
    setSelectedPageId(page.id)
  }

  return (
    <Card className='space-y-3 border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800'>
      <Flex align='center' justify='between'>
        <div>
          <Text className='text-lg font-semibold dark:text-white'>Batch Pipeline</Text>
          <Text className='text-sm text-gray-500 dark:text-gray-400'>Process multiple pages end-to-end</Text>
        </div>
        <Badge color={statusColors[status] ?? 'gray'}>{status.toUpperCase()}</Badge>
      </Flex>

      {error && (
        <Callout.Root color='red'>
          <Callout.Icon>
            <AlertTriangle className='h-4 w-4' />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      {!tauriAvailable && (
        <Callout.Root color='amber'>
          <Callout.Icon>
            <AlertTriangle className='h-4 w-4' />
          </Callout.Icon>
          <Callout.Text>
            This panel currently requires the desktop build. Launch the Tauri app to enable batch processing.
          </Callout.Text>
        </Callout.Root>
      )}

      <Flex gap='2' wrap='wrap'>
        <Button onClick={handleAddImages} disabled={busy} size='2'>
          <Upload className='mr-2 h-4 w-4' />
          Add Images
        </Button>
        <Button variant='soft' onClick={handleSelectOutputDir} disabled={busy} size='2'>
          <FolderOpen className='mr-2 h-4 w-4' />
          Output Folder
        </Button>
        <Button variant='ghost' color='gray' onClick={() => clearPages()} disabled={pages.length === 0 || status === 'running'} size='2'>
          <Trash2 className='mr-2 h-4 w-4' />
          Clear Queue
        </Button>
      </Flex>

      <Separator size='4' className='my-2' />

      <div className='space-y-2'>
        <Flex align='center' gap='2'>
          <Text className='text-sm font-medium dark:text-gray-200'>Overall Progress</Text>
          <Text className='text-xs text-gray-500 dark:text-gray-400'>{overallProgress}%</Text>
        </Flex>
        <Progress value={overallProgress} max={100} size='3' />
      </div>

      <Flex gap='2'>
        <Button onClick={handleStart} disabled={status === 'running' || pages.length === 0 || !outputDir || busy}> 
          <PlayCircle className='mr-2 h-4 w-4' />
          Start
        </Button>
        <Button onClick={handlePause} disabled={status !== 'running'} variant='soft'>
          <PauseCircle className='mr-2 h-4 w-4' />
          Pause
        </Button>
        <Button onClick={handleResume} disabled={status !== 'paused' || busy} variant='soft'>
          <RefreshCw className='mr-2 h-4 w-4' />
          Resume
        </Button>
        <Button onClick={handleCancel} disabled={status !== 'running' && status !== 'paused'} variant='soft' color='red'>
          <Square className='mr-2 h-4 w-4' />
          Cancel
        </Button>
      </Flex>

      <Flex direction='column' gap='1'>
        <Text className='text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400'>Output Directory</Text>
        <Text className='truncate font-mono text-xs text-gray-700 dark:text-gray-300'>
          {outputDir || 'Not selected'}
        </Text>
      </Flex>

      {summary && (
        <Callout.Root color='green'>
          <Callout.Icon>
            <CheckCircle2 className='h-4 w-4' />
          </Callout.Icon>
          <Callout.Text>
            Processed {summary.processedPages} pages with {summary.failedPages} failures in {Math.round(summary.durationMs / 1000)}s.
          </Callout.Text>
        </Callout.Root>
      )}

      {warnings.length > 0 && (
        <Callout.Root color='amber'>
          <Callout.Icon>
            <AlertTriangle className='h-4 w-4' />
          </Callout.Icon>
          <Callout.Text>
            <div className='space-y-1'>
              {warnings.slice(0, 4).map((message) => (
                <Text key={message} className='text-xs'>{message}</Text>
              ))}
              {warnings.length > 4 && (
                <Text className='text-xs text-gray-500'>+{warnings.length - 4} more…</Text>
              )}
            </div>
          </Callout.Text>
        </Callout.Root>
      )}

      <ScrollArea className='max-h-64 rounded border border-gray-200 dark:border-gray-700'>
        <Table.Root size='1'>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>File</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Progress</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Elapsed</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell align='right'>
                <span className='sr-only'>Actions</span>
              </Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {pages.length === 0 && (
              <Table.Row>
                <Table.Cell colSpan={5}>
                  <Text className='text-center text-sm text-gray-500'>No pages queued yet.</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {pages.map((page) => {
              const percent = getPercent(page.progress)
              const stageLabel = stageLabels[page.stage] ?? page.stage
              const isSelected = selectedPageId === page.id
              return (
                <Table.Row
                  key={page.id}
                  onClick={() => setSelectedPageId(page.id)}
                  className={`cursor-pointer transition-colors ${
                    isSelected ? 'bg-gray-50 dark:bg-gray-900' : ''
                  }`}
                  aria-selected={isSelected}
                >
                  <Table.Cell className='max-w-[140px] truncate text-xs font-medium'>{page.fileName}</Table.Cell>
                  <Table.Cell>
                    <Badge size='1' color={page.stage === 'failed' ? 'red' : page.stage === 'done' ? 'green' : 'gray'}>
                      {stageLabel}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell className='w-32'>
                    <Flex direction='column'>
                      <Progress value={percent} max={100} size='2' />
                      <Text className='text-right text-[10px] text-gray-500'>{percent}%</Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Text className='text-xs text-gray-600 dark:text-gray-300'>
                      {formatDuration(page.startedAt, page.completedAt)}
                    </Text>
                  </Table.Cell>
                  <Table.Cell align='right'>
                    <Flex gap='1' justify='end'>
                      <Button
                        size='1'
                        variant='ghost'
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleOpenOutput(page)
                        }}
                        disabled={!tauriAvailable || (!page.outputImagePath && !page.manifestPath)}
                        aria-label='Open output'
                      >
                        <ExternalLink className='h-3 w-3' />
                      </Button>
                      <Button
                        size='1'
                        variant='ghost'
                        color='blue'
                        onClick={(event) => {
                          event.stopPropagation()
                          handleRetryPage(page)
                        }}
                        disabled={
                          status === 'running' || (page.stage !== 'failed' && page.stage !== 'done')
                        }
                        aria-label='Retry page'
                      >
                        <RotateCcw className='h-3 w-3' />
                      </Button>
                      <Button
                        size='1'
                        variant='ghost'
                        color='red'
                        onClick={(event) => {
                          event.stopPropagation()
                          removePage(page.id)
                        }}
                        disabled={status === 'running'}
                        aria-label='Remove page'
                      >
                        <Trash2 className='h-3 w-3' />
                      </Button>
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table.Root>
      </ScrollArea>
      {selectedPage && (
        <div className='space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900'>
          <Flex align='center' justify='between'>
            <div>
              <Text className='text-sm font-semibold dark:text-gray-100'>Activity Log</Text>
              <Text className='text-xs text-gray-500 dark:text-gray-400'>{selectedPage.fileName}</Text>
            </div>
            <Flex gap='2'>
              <Button
                size='1'
                variant='soft'
                onClick={() => selectedPage && void handleOpenOutput(selectedPage)}
                disabled={!tauriAvailable || !canOpenSelectedOutput}
              >
                <ExternalLink className='mr-1 h-3 w-3' />
                Open Output
              </Button>
              <Button
                size='1'
                variant='soft'
                color='blue'
                onClick={() => selectedPage && handleRetryPage(selectedPage)}
                disabled={status === 'running' || !canRetrySelectedPage}
              >
                <RotateCcw className='mr-1 h-3 w-3' />
                Retry Page
              </Button>
            </Flex>
          </Flex>
          <ScrollArea className='max-h-48 pr-2'>
            {selectedLogs.length === 0 ? (
              <Text className='text-xs text-gray-500 dark:text-gray-400'>No log entries yet.</Text>
            ) : (
              <div className='space-y-2'>
                {selectedLogs.map((entry) => (
                  <div
                    key={entry.id}
                    className='rounded-md border border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-800'
                  >
                    <Flex align='center' gap='2' wrap='wrap'>
                      <Text className='font-mono text-[11px] text-gray-500 dark:text-gray-400'>
                        {formatLogTimestamp(entry.timestamp)}
                      </Text>
                      {entry.stage && (
                        <Badge size='1' color='gray'>
                          {stageLabels[entry.stage] ?? entry.stage}
                        </Badge>
                      )}
                      <Badge size='1' color={logLevelColors[entry.level] ?? 'gray'}>
                        {entry.level.toUpperCase()}
                      </Badge>
                    </Flex>
                    <Text className='text-xs text-gray-700 dark:text-gray-200'>{entry.message}</Text>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      )}
    </Card>
  )
}

export default BatchPanel
