'use client'

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import DetectionPanel from '@/components/detection-panel'
import Tools from '@/components/tools'
import Topbar from '@/components/topbar'
import Canvas from '@/components/canvas'
import OCRPanel from '@/components/ocr-panel'
import TranslationPanel from '@/components/translation-panel'
import InpaintPanel from '@/components/inpaint-panel'
import InpaintSettings from '@/components/inpaint-settings'
import RenderPanel from '@/components/render-panel'
import { useEditorStore } from '@/lib/state'

const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_COLLAPSED_WIDTH = 48
const SIDEBAR_MAX_WIDTH_RATIO = 0.5

function App() {
  const {
    tool: selectedTool,
    theme,
    sidebarWidth,
    lastExpandedSidebarWidth,
    isSidebarCollapsed,
    setSidebarWidth,
    setLastExpandedSidebarWidth,
    setIsSidebarCollapsed,
  } = useEditorStore()

  const [isTouchDevice, setIsTouchDevice] = useState(false)
  const [transitionsEnabled, setTransitionsEnabled] = useState(true)
  const [isHandleHovered, setHandleHovered] = useState(false)
  const [isHandleDragging, setHandleDragging] = useState(false)

  // Apply theme on mount
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }
  }, [theme])

  // Detect touch-capable devices to widen the resize handle for accessibility
  useEffect(() => {
    if (typeof window === 'undefined') return
    const nav = navigator as Navigator & { msMaxTouchPoints?: number }
    const touchCapable =
      'ontouchstart' in window || (nav.maxTouchPoints ?? 0) > 0 || (nav.msMaxTouchPoints ?? 0) > 0
    setIsTouchDevice(touchCapable)
  }, [])

  const clampExpandedWidth = useCallback((width: number) => {
    const safeWidth = Number.isFinite(width) ? width : SIDEBAR_MIN_WIDTH
    if (typeof window === 'undefined') {
      return Math.max(SIDEBAR_MIN_WIDTH, safeWidth)
    }
    const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(window.innerWidth * SIDEBAR_MAX_WIDTH_RATIO))
    return Math.round(Math.min(Math.max(safeWidth, SIDEBAR_MIN_WIDTH), maxWidth))
  }, [])

  const ensureSidebarWithinBounds = useCallback(() => {
    const clampedExpanded = clampExpandedWidth(lastExpandedSidebarWidth)
    if (clampedExpanded !== lastExpandedSidebarWidth) {
      setLastExpandedSidebarWidth(clampedExpanded)
    }

    if (!isSidebarCollapsed) {
      const clampedCurrent = clampExpandedWidth(sidebarWidth)
      if (clampedCurrent !== sidebarWidth) {
        setSidebarWidth(clampedCurrent)
      }
    }
  }, [clampExpandedWidth, isSidebarCollapsed, lastExpandedSidebarWidth, sidebarWidth, setLastExpandedSidebarWidth, setSidebarWidth])

  useEffect(() => {
    ensureSidebarWithinBounds()
    if (typeof window === 'undefined') return

    const handleResize = () => {
      ensureSidebarWithinBounds()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [ensureSidebarWithinBounds])

  const toggleSidebarCollapsed = useCallback(() => {
    const expandedWidth = clampExpandedWidth(isSidebarCollapsed ? lastExpandedSidebarWidth : sidebarWidth)

    if (isSidebarCollapsed) {
      setSidebarWidth(expandedWidth)
      setLastExpandedSidebarWidth(expandedWidth)
      setIsSidebarCollapsed(false)
    } else {
      setLastExpandedSidebarWidth(expandedWidth)
      setIsSidebarCollapsed(true)
      setSidebarWidth(SIDEBAR_COLLAPSED_WIDTH)
    }
    setTransitionsEnabled(true)
  }, [clampExpandedWidth, isSidebarCollapsed, lastExpandedSidebarWidth, sidebarWidth, setIsSidebarCollapsed, setLastExpandedSidebarWidth, setSidebarWidth])

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebarCollapsed()
      }
    }

    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [toggleSidebarCollapsed])

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      const startingExpandedWidth = clampExpandedWidth(
        isSidebarCollapsed ? lastExpandedSidebarWidth : sidebarWidth,
      )

      if (isSidebarCollapsed) {
        setIsSidebarCollapsed(false)
        setSidebarWidth(startingExpandedWidth)
      }

      setLastExpandedSidebarWidth(startingExpandedWidth)
      setHandleHovered(true)
      setHandleDragging(true)
      setTransitionsEnabled(false)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const startX = event.clientX

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault()
  const delta = moveEvent.clientX - startX
  const nextWidth = clampExpandedWidth(startingExpandedWidth - delta)
        setSidebarWidth(nextWidth)
        setLastExpandedSidebarWidth(nextWidth)
      }

      const finishPointerInteraction = () => {
        document.removeEventListener('pointermove', handlePointerMove)
        document.removeEventListener('pointerup', finishPointerInteraction)
        document.removeEventListener('pointercancel', finishPointerInteraction)
        setHandleDragging(false)
        setHandleHovered(false)
        setTransitionsEnabled(true)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }

      document.addEventListener('pointermove', handlePointerMove)
      document.addEventListener('pointerup', finishPointerInteraction)
      document.addEventListener('pointercancel', finishPointerInteraction)
    },
    [
      clampExpandedWidth,
      isSidebarCollapsed,
      lastExpandedSidebarWidth,
      setIsSidebarCollapsed,
      setLastExpandedSidebarWidth,
      setSidebarWidth,
      sidebarWidth,
    ],
  )

  const baseHandleWidth = isTouchDevice ? 12 : 4
  const activeHandleWidth = isTouchDevice ? 16 : 6
  const handleWidth = isHandleDragging || isHandleHovered ? activeHandleWidth : baseHandleWidth
  const contentPaddingLeft = baseHandleWidth + 8
  const expandedWidth = clampExpandedWidth(isSidebarCollapsed ? lastExpandedSidebarWidth : sidebarWidth)
  const effectiveSidebarWidth = isSidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : expandedWidth

  return (
    <main className='flex h-screen max-h-screen w-screen max-w-screen flex-col bg-gray-200 dark:bg-gray-900'>
      <Topbar />
      <div className='flex flex-1 overflow-hidden bg-gray-200 dark:bg-gray-900'>
        <div className='flex h-full w-20 items-start p-3'>
          <Tools />
        </div>

        <div className='flex flex-1 overflow-hidden'>
          <div className='flex flex-1 flex-col items-center justify-center'>
            <Canvas />
          </div>

          <aside
            className='relative h-full border-l border-gray-200 bg-white/95 shadow-inner dark:border-gray-700 dark:bg-gray-900/70'
            style={{
              width: effectiveSidebarWidth,
              minWidth: isSidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_MIN_WIDTH,
              transition: transitionsEnabled ? 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
            }}
          >
            <div
              role='separator'
              aria-orientation='vertical'
              title='Drag to resize sidebar'
              className={`absolute left-0 top-0 z-20 h-full transition-colors duration-200 ${
                isHandleDragging || isHandleHovered ? 'bg-blue-500/50' : 'bg-transparent'
              }`}
              style={{
                width: handleWidth,
                cursor: 'col-resize',
                transition: 'background-color 0.2s ease, width 0.2s ease',
              }}
              onPointerDown={handleResizePointerDown}
              onPointerEnter={() => setHandleHovered(true)}
              onPointerLeave={() => {
                if (!isHandleDragging) {
                  setHandleHovered(false)
                }
              }}
            />

            <div
              className='flex h-full flex-col text-gray-900 dark:text-gray-100'
              style={{ paddingLeft: contentPaddingLeft }}
            >
              <div
                className={`flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700 ${
                  isSidebarCollapsed ? 'justify-center' : 'justify-between'
                }`}
              >
                <button
                  type='button'
                  aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  aria-expanded={!isSidebarCollapsed}
                  onClick={toggleSidebarCollapsed}
                  className='flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 bg-white shadow-sm transition-colors hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700'
                >
                  <Menu className='h-5 w-5 text-gray-700 dark:text-gray-200' />
                </button>
                {!isSidebarCollapsed && (
                  <span className='text-sm font-semibold text-gray-700 dark:text-gray-200'>Panels</span>
                )}
              </div>

              <div
                className='flex-1 overflow-y-auto px-3 pb-3 pt-2 transition-opacity duration-200'
                style={{
                  opacity: isSidebarCollapsed ? 0 : 1,
                  pointerEvents: isSidebarCollapsed ? 'none' : 'auto',
                  visibility: isSidebarCollapsed ? 'hidden' : 'visible',
                }}
              >
                <div className='flex h-full flex-col gap-2'>
                  {selectedTool === 'detection' && (
                    <>
                      <DetectionPanel />
                      <OCRPanel />
                    </>
                  )}
                  {selectedTool === 'translation' && <TranslationPanel />}
                  {selectedTool === 'inpaint' && (
                    <>
                      <InpaintSettings />
                      <InpaintPanel />
                    </>
                  )}
                  {selectedTool === 'render' && <RenderPanel />}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}

export default App
