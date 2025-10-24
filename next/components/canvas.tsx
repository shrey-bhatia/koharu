'use client'

import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva'
import ScaleControl from './scale-control'
import { useEditorStore } from '@/lib/state'
import type { TextBlock } from '@/lib/state'
import { useZoomPerformance } from '@/utils/zoom-performance'

const generateBlockId = (): string => {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined

  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID()
  }

  if (cryptoObj?.getRandomValues) {
    const buffer = new Uint32Array(4)
    cryptoObj.getRandomValues(buffer)
    return Array.from(buffer, (value) => value.toString(16).padStart(8, '0')).join('')
  }

  return `block-${Math.random().toString(36).slice(2, 10)}`
}

function Canvas() {
  const {
    tool,
    scale,
    setScale,
    image,
  textBlocks,
  setTextBlocks,
  updateTextBlock,
    inpaintedImage,
    segmentationMaskBitmap,
    showSegmentationMask,
  selectedBlockIndex,
  setSelectedBlockIndex,
  selectedBlockId,
  setSelectedBlockId,
    currentStage,
    pipelineStages,
    renderMethod,
    selectionSensitivity,
    zoomOptimizationsEnabled,
    zoomMetricsEnabled,
    setAddTextAreaHandler,
  } = useEditorStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const inpaintLayerRef = useRef<Konva.Layer>(null)
  const stageRef = useRef<Konva.Stage>(null)

  const [isTouchDevice, setIsTouchDevice] = useState(false)
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 })
  const stagePosRef = useRef(stagePos)
  const isBlockDraggingRef = useRef(false)
  const stageDraggablePrevRef = useRef<boolean | null>(null)
  const [isZooming, setIsZooming] = useState(false)
  const stageLockRef = useRef(false)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })
  const transformerRef = useRef<Konva.Transformer>(null)
  const safeScale = Math.max(scale, 0.001)
  const stageScale = stageRef.current?.scaleX?.() ?? safeScale
  const screenSpace = useMemo(() => {
    const clampedScale = Math.max(0.1, Math.min(5, stageScale || 1))
    const anchorSize = Math.max(6, Math.min(16, 10 / clampedScale))
    const borderStrokeWidth = Math.max(1, Math.min(3, 2 / clampedScale))
    const hitStrokeWidth = Math.max(8, 12 / clampedScale)
    const padding = Math.max(6, Math.min(24, 8 / clampedScale))
    return { anchorSize, borderStrokeWidth, hitStrokeWidth, padding }
  }, [stageScale])
  const isDetectionMode = tool === 'detection'
  const activeSelectionKey = useMemo(() => {
    if (selectedBlockId) return selectedBlockId
    if (selectedBlockIndex != null) return String(selectedBlockIndex)
    return null
  }, [selectedBlockId, selectedBlockIndex])

  const lockStage = useCallback((locked: boolean) => {
    stageLockRef.current = locked

    if (locked) {
      stageRef.current?.stopDrag()
    }

    if (process.env.NODE_ENV !== 'production') {
      console.info('stage.lock', { locked })
    }
  }, [])

  // Performance monitoring
  const perfMonitor = useZoomPerformance(zoomMetricsEnabled)

  // Optimized zoom state management with rAF batching and pointer anchoring
  const pendingScaleRef = useRef<number | null>(null)
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const wheelTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const transformerDebounceRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const stage = stageRef.current
    const transformer = transformerRef.current

    if (!stage || !transformer) return

    if (!isDetectionMode || !activeSelectionKey) {
      transformer.nodes([])
      transformer.getLayer()?.batchDraw()
      return
    }

    const node = stage.findOne(`.region-${activeSelectionKey}`)
    transformer.nodes(node ? [node] : [])
    if (process.env.NODE_ENV !== 'production') {
      console.info('transformer.attach', {
        id: selectedBlockId,
        index: selectedBlockIndex,
        key: activeSelectionKey,
        found: Boolean(node),
      })
    }
    transformer.getLayer()?.batchDraw()
  }, [activeSelectionKey, isDetectionMode, selectedBlockId, selectedBlockIndex, textBlocks])

  useEffect(() => {
    transformerRef.current?.getLayer()?.batchDraw()
  }, [screenSpace])

  useEffect(() => {
    stagePosRef.current = stagePos
  }, [stagePos])

  // Debounced transformer redraw during zoom
  useEffect(() => {
    if (!isZooming) {
      // Immediate update when not zooming
      transformerRef.current?.getLayer()?.batchDraw()
    } else {
      // Debounce during continuous zoom (150ms after zoom ends)
      if (transformerDebounceRef.current) {
        clearTimeout(transformerDebounceRef.current)
      }
      transformerDebounceRef.current = setTimeout(() => {
        transformerRef.current?.getLayer()?.batchDraw()
      }, 150)
    }
  }, [scale, selectionSensitivity, isZooming])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const nav = navigator as Navigator & { msMaxTouchPoints?: number }
    const touchCapable =
      'ontouchstart' in window || (nav.maxTouchPoints ?? 0) > 0 || (nav.msMaxTouchPoints ?? 0) > 0
    setIsTouchDevice(touchCapable)
  }, [])

  // Update container size on mount and resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setContainerSize({ width: rect.width, height: rect.height })
      }
    }

    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  // Compute fit-to-viewport scale
  const computeFitScale = useCallback(() => {
    if (!image || !containerSize.width || !containerSize.height) return 1
    const scaleX = containerSize.width / image.bitmap.width
    const scaleY = containerSize.height / image.bitmap.height
    return Math.min(scaleX, scaleY, 1.0) // Don't upscale beyond 100%
  }, [image, containerSize])

  // Fit image to viewport and center
  const fitAndCenter = useCallback(() => {
    if (!stageRef.current || !image) return

    const fitScale = computeFitScale()
    const imgW = image.bitmap.width * fitScale
    const imgH = image.bitmap.height * fitScale

    // Center the image in viewport
    const newPos = {
      x: (containerSize.width - imgW) / 2,
      y: (containerSize.height - imgH) / 2,
    }

    setScale(fitScale)
    setStagePos(newPos)
  }, [image, containerSize, computeFitScale, setScale])

  // Reset view on image load
  useEffect(() => {
    if (image) {
      fitAndCenter()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.bitmap])

  // Handler for adding a new text area at viewport center
  const handleAddTextArea = useCallback(() => {
    if (!image || !stageRef.current) return

    const stage = stageRef.current
    // Get viewport center in screen coordinates
    const centerScreen = { x: containerSize.width / 2, y: containerSize.height / 2 }
    // Convert to world coordinates
    const centerWorld = toWorld(stage, centerScreen)

    const defaultSize = 100 // Size in world coordinates

    const newId = generateBlockId()

    const newBlock: TextBlock = {
      id: newId,
      xmin: centerWorld.x - defaultSize / 2,
      ymin: centerWorld.y - defaultSize / 2,
      xmax: centerWorld.x + defaultSize / 2,
      ymax: centerWorld.y + defaultSize / 2,
      confidence: 1.0,
      class: 0, // Default to black text
    }

    setTextBlocks([...textBlocks, newBlock])
    setSelectedBlockIndex(textBlocks.length)
    setSelectedBlockId(newId)
  }, [image, containerSize, textBlocks, setTextBlocks, setSelectedBlockIndex, setSelectedBlockId])

  // Register addTextArea handler in store
  useEffect(() => {
    setAddTextAreaHandler(handleAddTextArea)
    return () => setAddTextAreaHandler(null)
  }, [handleAddTextArea, setAddTextAreaHandler])

  const clampStagePosition = useCallback(
    ({ x, y, scale: scaleOverride }: { x: number; y: number; scale?: number }) => {
      if (!image) {
        return { x, y }
      }

      const useScale = scaleOverride ?? scale
      const imgW = image.bitmap.width * useScale
      const imgH = image.bitmap.height * useScale
      const minX = containerSize.width - imgW
      const minY = containerSize.height - imgH
      const clampedX = Math.min(0, Math.max(minX, x))
      const clampedY = Math.min(0, Math.max(minY, y))

      return { x: clampedX, y: clampedY }
    },
    [containerSize.width, containerSize.height, image, scale]
  )

  useEffect(() => {
    setStagePos((prev) => {
      const clamped = clampStagePosition({ x: prev.x, y: prev.y })
      if (stageRef.current && (clamped.x !== prev.x || clamped.y !== prev.y)) {
        stageRef.current.position(clamped)
      }
      return clamped
    })
  }, [clampStagePosition])

  // Zoom with anchor point (viewport center for buttons/keyboard, pointer for wheel)
  const applyZoom = useCallback((targetScale: number, mode: 'button' | 'keyboard' | 'wheel' = 'button') => {
    if (!stageRef.current || !image) return

    const stage = stageRef.current
    const clampedScale = Math.max(0.1, Math.min(2.0, targetScale))
    const oldScale = stage.scaleX()
    const oldPos = stage.position()

    // Determine anchor point based on input mode
    let anchor: { x: number; y: number }
    if (mode === 'wheel') {
      // Use pointer position for wheel zoom
      const pointer = stage.getPointerPosition()
      anchor = pointer ?? { x: containerSize.width / 2, y: containerSize.height / 2 }
    } else {
      // Use viewport center for button/keyboard zoom
      anchor = { x: containerSize.width / 2, y: containerSize.height / 2 }
    }

    // Convert anchor to world coordinates
    const mousePointTo = {
      x: (anchor.x - oldPos.x) / oldScale,
      y: (anchor.y - oldPos.y) / oldScale,
    }

    // Calculate new position to keep anchor point stable
    const newPos = {
      x: anchor.x - mousePointTo.x * clampedScale,
      y: anchor.y - mousePointTo.y * clampedScale,
    }

    // Clamp position to keep image partially in view
    const clampedPos = clampStagePosition({
      x: newPos.x,
      y: newPos.y,
      scale: clampedScale,
    })

    setScale(clampedScale)
    setStagePos(clampedPos)
  }, [clampStagePosition, image, containerSize, setScale])

  // Mouse wheel zoom handler with pointer anchoring
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()

    if (!stageRef.current) return

    // Mark as zooming (for transformer debounce)
    setIsZooming(true)

    // Start performance tracking
    if (zoomMetricsEnabled && wheelTimeoutRef.current === null) {
      perfMonitor.startGesture()
      perfMonitor.markWheelStart()
    }

    // Get pointer position in Stage coordinates (NOT DOM coordinates)
    const stage = stageRef.current
    const pointer = stage.getPointerPosition()

    if (!pointer) return

    const oldScale = stage.scaleX()
    const oldPos = stage.position()

    // Calculate zoom delta with multiplicative scaling for smoother feel
    const scaleDelta = e.deltaY > 0 ? 0.95 : 1.05
    const targetScale = oldScale * scaleDelta
    const clampedScale = Math.max(0.1, Math.min(2.0, targetScale))

    // Quantize to 0.01 increments to avoid floating-point jitter
    const quantizedScale = Math.round(clampedScale * 100) / 100

    // Convert pointer position to world coordinates at current scale
    const mousePointTo = {
      x: (pointer.x - oldPos.x) / oldScale,
      y: (pointer.y - oldPos.y) / oldScale,
    }

    // Calculate new position to keep world point under pointer
    const newPos = {
      x: pointer.x - mousePointTo.x * quantizedScale,
      y: pointer.y - mousePointTo.y * quantizedScale,
    }

    // Apply scale and position
    if (zoomOptimizationsEnabled) {
      pendingScaleRef.current = quantizedScale
      pendingPosRef.current = newPos

      if (rafIdRef.current === null) {
        const frameStart = performance.now()
        rafIdRef.current = requestAnimationFrame(() => {
          if (pendingScaleRef.current !== null) {
            setScale(pendingScaleRef.current)
            pendingScaleRef.current = null
          }
          if (pendingPosRef.current !== null) {
            setStagePos(pendingPosRef.current)
            pendingPosRef.current = null
          }

          if (zoomMetricsEnabled) {
            const frameDuration = performance.now() - frameStart
            perfMonitor.recordFrame(frameDuration)
          }

          rafIdRef.current = null
        })
      }
    } else {
      // Direct update (legacy)
      setScale(quantizedScale)
      setStagePos(newPos)
    }

    // End performance tracking and reset zooming flag after gesture completes (300ms idle)
    if (wheelTimeoutRef.current) {
      clearTimeout(wheelTimeoutRef.current)
    }
    wheelTimeoutRef.current = setTimeout(() => {
      setIsZooming(false)
      if (zoomMetricsEnabled) {
        perfMonitor.markWheelEnd()
        perfMonitor.endGesture()
      }
      wheelTimeoutRef.current = null
    }, 300)
  }, [setScale, zoomOptimizationsEnabled, zoomMetricsEnabled, perfMonitor])

  // Keyboard shortcuts for zoom
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
      e.preventDefault()
      applyZoom(scale * 1.05, 'keyboard')
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault()
      applyZoom(scale * 0.95, 'keyboard')
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault()
      fitAndCenter() // Reset to fit-and-center
    }
  }, [scale, applyZoom, fitAndCenter])

  // Attach wheel and keyboard event listeners
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleKeyDown)

      // Cleanup pending operations
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
      if (wheelTimeoutRef.current !== null) {
        clearTimeout(wheelTimeoutRef.current)
      }
    }
  }, [handleWheel, handleKeyDown])

  const handleBlockPointerDown = useCallback(
    (event: KonvaEventObject<Event>, block: TextBlock, index: number) => {
      lockStage(true)
      stageRef.current?.stopDrag()
      if (stageRef.current) {
        stageDraggablePrevRef.current = stageRef.current.draggable()
        stageRef.current.draggable(false)
      }
      isBlockDraggingRef.current = false

      const blockIdOrNull = block.id ?? null
      const alreadySelectedById = selectedBlockId === blockIdOrNull
      const alreadySelectedByIndex = selectedBlockIndex === index

      if (!alreadySelectedByIndex) {
        setSelectedBlockIndex(index)
      }
      if (!alreadySelectedById) {
        setSelectedBlockId(blockIdOrNull)
      }
      event.cancelBubble = true
      if (process.env.NODE_ENV !== 'production') {
        console.info('block.pointer.down', {
          id: block.id,
          index,
          point: event?.evt ? { x: (event.evt as PointerEvent).clientX, y: (event.evt as PointerEvent).clientY } : null,
        })
      }
      if (process.env.NODE_ENV !== 'production') {
        console.info('block.select', { id: block.id, index })
      }

      const potentialGroup = event.currentTarget as Konva.Node | null
      const dragNode = potentialGroup && typeof (potentialGroup as any).startDrag === 'function'
        ? potentialGroup
        : (event.target as Konva.Node | null)

      if (dragNode && typeof (dragNode as any).startDrag === 'function') {
        const wasDraggable = dragNode.draggable()
        if (!wasDraggable) {
          dragNode.draggable(true)
        }
        dragNode.startDrag()
        if (!wasDraggable) {
          dragNode.draggable(false)
        }
      }
    },
    [lockStage, selectedBlockId, selectedBlockIndex, setSelectedBlockId, setSelectedBlockIndex]
  )

  const handleBlockPointerUp = useCallback(
    (event: KonvaEventObject<Event>) => {
      if (!isBlockDraggingRef.current) {
        lockStage(false)
        if (stageRef.current && stageDraggablePrevRef.current !== null) {
          stageRef.current.draggable(stageDraggablePrevRef.current)
        }
      }
      stageDraggablePrevRef.current = null
      event.cancelBubble = true
    },
    [lockStage]
  )

  // Coordinate conversion helpers
  // Convert Stage/screen coordinates to world (image) coordinates
  const toWorld = (stage: Konva.Stage, p: { x: number; y: number }) => {
    const s = stage.scaleX()
    const sp = stage.position()
    return { x: (p.x - sp.x) / s, y: (p.y - sp.y) / s }
  }

  // Convert world (image) coordinates to Stage/screen coordinates
  const toScreen = (stage: Konva.Stage, p: { x: number; y: number }) => {
    const s = stage.scaleX()
    const sp = stage.position()
    return { x: p.x * s + sp.x, y: p.y * s + sp.y }
  }

  // Handler for when a box is transformed (scaled/rotated/resized)
  const handleTransformEnd = useCallback(
    (block: TextBlock, index: number, event: KonvaEventObject<Event>) => {
      const node = event.target as Konva.Node

      const scaleX = node.scaleX()
      const scaleY = node.scaleY()
      const x = node.x()
      const y = node.y()
      const width = Math.max(1, node.width() * scaleX)
      const height = Math.max(1, node.height() * scaleY)

      node.scaleX(1)
      node.scaleY(1)

      updateTextBlock(
        { id: block.id, index },
        (current) => ({
          ...current,
          xmin: x,
          ymin: y,
          xmax: x + width,
          ymax: y + height,
          ocrStale: true,
        })
      )
    },
    [updateTextBlock]
  )

  // Memoized box styles to avoid recalculation on every render
  const boxStyles = useMemo(() => {
    const offset = Math.max(8, 12 / stageScale)
    const hitStrokeWidth = screenSpace.hitStrokeWidth + selectionSensitivity * 0.5

    return textBlocks.map(() => ({
      strokeWidth: screenSpace.borderStrokeWidth,
      hitStrokeWidth,
      fontSize: 30 / safeScale,
      radius: 20 / safeScale,
      anchorSize: screenSpace.anchorSize,
      padding: screenSpace.padding,
      borderStrokeWidth: screenSpace.borderStrokeWidth,
      labelOffset: offset,
    }))
  }, [selectionSensitivity, screenSpace, stageScale, textBlocks, safeScale])

  // Determine which base image to display based on currentStage and renderMethod
  const getBaseImage = () => {
    // For inpaint tool, always show the current stage content
    // Don't override stage selection based on tool
    switch (currentStage) {
      case 'textless':
        return pipelineStages.textless?.bitmap || image?.bitmap || null
      case 'rectangles':
        return pipelineStages.withRectangles?.bitmap || pipelineStages.textless?.bitmap || image?.bitmap || null
      case 'final':
        return pipelineStages.final?.bitmap || image?.bitmap || null
      case 'original':
      default:
        return image?.bitmap || null
    }
  }

  const baseImage = getBaseImage()
  const shouldShowOverlays = tool === 'render' && (currentStage === 'rectangles' || currentStage === 'final')
  const shouldShowMaskOverlay = Boolean(segmentationMaskBitmap && (tool === 'segmentation' || showSegmentationMask))
  const hasActiveSelection = activeSelectionKey != null
  const allowStageDrag = Boolean(image) && (!isDetectionMode || !hasActiveSelection)

  const stageDragBound = useCallback(
    (pos: Konva.Vector2d) => {
      if (!allowStageDrag || stageLockRef.current || isBlockDraggingRef.current) {
        return stagePosRef.current
      }

      const clamped = clampStagePosition({ x: pos.x, y: pos.y })
      stagePosRef.current = clamped
      return clamped
    },
    [allowStageDrag, clampStagePosition]
  )

  // Visibility guards for layers (only render active layers)
  const showDetectionLayer = isDetectionMode
  const showRenderRectanglesLayer = shouldShowOverlays && renderMethod === 'rectangle'
  const showRenderTextLayer = tool === 'render' && currentStage === 'final'
  const showSegmentationLayer = tool === 'segmentation'
  const showInpaintLayer = tool === 'inpaint' && inpaintedImage

  useEffect(() => {
    if (!showDetectionLayer && stageLockRef.current) {
      lockStage(false)
    }
  }, [showDetectionLayer, lockStage])

  useEffect(() => {
    if (!isDetectionMode) {
      transformerRef.current?.nodes([])
      lockStage(false)
      setSelectedBlockId(null)
      setSelectedBlockIndex(null)
    }
  }, [isDetectionMode, lockStage, setSelectedBlockId, setSelectedBlockIndex])

  return (
    <>
      <div ref={containerRef} className='relative h-full w-full flex-1'>
        <div className='absolute inset-0 flex items-center-safe justify-center-safe overflow-auto'>
          <div className='p-2'>
            <Stage
              ref={stageRef}
              scaleX={scale}
              scaleY={scale}
              x={stagePos.x}
              y={stagePos.y}
              width={containerSize.width}
              height={containerSize.height}
              dragDistance={isTouchDevice ? 16 : 12}
              draggable={allowStageDrag}
              dragBoundFunc={stageDragBound}
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  setSelectedBlockIndex(null)
                  setSelectedBlockId(null)
                  lockStage(false)
                }
              }}
              onTap={(event) => {
                if (event.target === event.currentTarget) {
                  setSelectedBlockIndex(null)
                  setSelectedBlockId(null)
                  lockStage(false)
                }
              }}
              onDragStart={(event) => {
                const isStageSelf = event.target === event.currentTarget
                if (!isStageSelf) {
                  return
                }

                if (!allowStageDrag || stageLockRef.current || isBlockDraggingRef.current) {
                  event.target.stopDrag()
                  return
                }

                if (process.env.NODE_ENV !== 'production') {
                  const pointer = stageRef.current?.getPointerPosition()
                  console.info('stage.drag.start', {
                    stageLocked: stageLockRef.current,
                    draggable: allowStageDrag && !stageLockRef.current,
                    pointer,
                  })
                }
              }}
              onDragEnd={(e) => {
                const isStageSelf = e.target === e.currentTarget
                if (!isStageSelf) {
                  return
                }

                if (process.env.NODE_ENV !== 'production') {
                  console.info('stage.drag.end', {
                    position: { x: e.target.x(), y: e.target.y() },
                  })
                }

                const finalPos = clampStagePosition({ x: e.target.x(), y: e.target.y() })
                stagePosRef.current = finalPos
                setStagePos(finalPos)
                if (stageRef.current && (finalPos.x !== e.target.x() || finalPos.y !== e.target.y())) {
                  stageRef.current.position(finalPos)
                }
              }}
            >
              {/* Layer 1: Base image (respects pipeline stage) */}
              <Layer>
                <KonvaImage image={baseImage} x={0} y={0} />
              </Layer>

              {/* Layer 1.5: Segmentation overlay */}
              {shouldShowMaskOverlay && (
                <Layer listening={false} opacity={0.6}>
                  <KonvaImage image={segmentationMaskBitmap || null} x={0} y={0} listening={false} />
                </Layer>
              )}

              {/* Layer 2: Rectangle fills (render mode, only for 'rectangles' and 'final' stages) */}
              {showRenderRectanglesLayer && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    if (!block.backgroundColor) return null

                    const bg = block.manualBgColor || block.backgroundColor
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin

                    return (
                      <Rect
                        key={`fill-${index}`}
                        x={xmin}
                        y={ymin}
                        width={width}
                        height={height}
                        fill={`rgb(${bg.r}, ${bg.g}, ${bg.b})`}
                        cornerRadius={5}
                      />
                    )
                  })}
                </Layer>
              )}

              {/* Layer 3: Translated text (render mode, only for 'final' stage) */}
              {showRenderTextLayer && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    if (!block.translatedText || !block.fontSize || !block.textColor) return null

                    const textColor = block.manualTextColor || block.textColor
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin

                    // Check for outline from appearance analysis
                    const hasOutline = block.appearance?.sourceOutlineColor && block.appearance?.outlineWidthPx
                    const outlineColor = hasOutline ? block.appearance.sourceOutlineColor : undefined
                    const outlineWidth = hasOutline ? block.appearance.outlineWidthPx : undefined

                    return (
                      <Text
                        key={`translated-${index}`}
                        x={xmin}
                        y={ymin}
                        width={width}
                        height={height}
                        text={block.translatedText}
                        fontSize={block.fontSize}
                        fontFamily={block.fontFamily || 'Arial'}
                        fill={`rgb(${textColor.r}, ${textColor.g}, ${textColor.b})`}
                        stroke={outlineColor ? `rgb(${outlineColor.r}, ${outlineColor.g}, ${outlineColor.b})` : undefined}
                        strokeWidth={outlineWidth}
                        letterSpacing={block.letterSpacing}
                        lineHeight={block.lineHeight}
                        align='center'
                        verticalAlign='middle'
                        wrap='word'
                      />
                    )
                  })}
                </Layer>
              )}

              {/* Layer 4: Detection boxes (detection mode) */}
              {showDetectionLayer && (
                <Layer>
                  {textBlocks?.map((block, index) => {
                    const { xmin, ymin, xmax, ymax } = block
                    const width = xmax - xmin
                    const height = ymax - ymin
                    const styles = boxStyles[index]
                    const regionKey = block.id ?? String(index)
                    const isSelected = block.id
                      ? block.id === selectedBlockId
                      : selectedBlockIndex === index
                    const strokeColor = isSelected
                      ? '#1976d2'
                      : block.ocrStale
                        ? '#f97316'
                        : '#e11d48'

                    const labelOffset = styles.labelOffset
                    const labelX = -labelOffset
                    const labelY = -labelOffset
                    const labelDiameter = styles.radius * 2

                    return (
                      <Group
                        key={`region-${regionKey}`}
                        name={`region-${regionKey}`}
                        data-block-id={block.id ?? undefined}
                        x={xmin}
                        y={ymin}
                        width={width}
                        height={height}
                        draggable
                        onPointerDown={(e) => handleBlockPointerDown(e, block, index)}
                        onClick={(e) => handleBlockPointerDown(e, block, index)}
                        onTap={(e) => handleBlockPointerDown(e, block, index)}
                        onPointerUp={handleBlockPointerUp}
                        onDragMove={(e) => {
                          e.cancelBubble = true
                          if (!isBlockDraggingRef.current) {
                            isBlockDraggingRef.current = true
                          }
                        }}
                        onDragEnd={(e) => {
                          e.cancelBubble = true
                          const node = e.target as Konva.Node
                          const newX = node.x()
                          const newY = node.y()
                          if (process.env.NODE_ENV !== 'production') {
                            console.info('block.drag.end', {
                              id: block.id,
                              index,
                              position: { x: newX, y: newY },
                            })
                          }

                          updateTextBlock(
                            { id: block.id, index },
                            (current) => {
                              const currentWidth = current.xmax - current.xmin
                              const currentHeight = current.ymax - current.ymin
                              return {
                                ...current,
                                xmin: newX,
                                ymin: newY,
                                xmax: newX + currentWidth,
                                ymax: newY + currentHeight,
                                ocrStale: true,
                              }
                            }
                          )
                          isBlockDraggingRef.current = false
                          if (stageRef.current && stageDraggablePrevRef.current !== null) {
                            stageRef.current.draggable(stageDraggablePrevRef.current)
                          }
                          stageDraggablePrevRef.current = null
                          lockStage(false)
                        }}
                        onTransformStart={(e) => {
                          handleBlockPointerDown(e, block, index)
                          lockStage(true)
                        }}
                        onTransformEnd={(e) => {
                          e.cancelBubble = true
                          handleTransformEnd(block, index, e)
                          isBlockDraggingRef.current = false
                          lockStage(false)
                        }}
                      >
                        <Rect
                          // Nearly invisible fill ensures the entire box is draggable/selectable
                          x={0}
                          y={0}
                          width={width}
                          height={height}
                          fill='black'
                          opacity={0.001}
                        />
                        <Rect
                          x={0}
                          y={0}
                          width={width}
                          height={height}
                          stroke={strokeColor}
                          strokeWidth={styles.strokeWidth}
                          strokeScaleEnabled={false}
                          perfectDrawEnabled={false}
                          hitStrokeWidth={styles.hitStrokeWidth}
                        />
                        <Circle
                          x={labelX}
                          y={labelY}
                          radius={styles.radius}
                          fill='rgba(255, 0, 0, 0.7)'
                          listening={false}
                        />
                        <Text
                          x={labelX}
                          y={labelY}
                          text={(index + 1).toString()}
                          fontSize={styles.fontSize}
                          fill='white'
                          fontFamily='sans-serif'
                          width={labelDiameter}
                          height={labelDiameter}
                          offsetX={labelDiameter / 2}
                          offsetY={labelDiameter / 2}
                          align='center'
                          verticalAlign='middle'
                          listening={false}
                        />
                      </Group>
                    )
                  })}
                  <Transformer
                    ref={transformerRef}
                    visible={Boolean(activeSelectionKey)}
                    listening={Boolean(activeSelectionKey)}
                    ignoreStroke={false}
                    rotateEnabled={false}
                    anchorSize={screenSpace.anchorSize}
                    padding={screenSpace.padding}
                    borderStroke='#1976d2'
                    borderStrokeWidth={screenSpace.borderStrokeWidth}
                    anchorStroke='#1976d2'
                    anchorFill='#ffffff'
                    anchorCornerRadius={2}
                  />
                </Layer>
              )}
              {showSegmentationLayer && (
                <Layer>
                  <KonvaImage image={null} x={0} y={0} />
                </Layer>
              )}
              {showInpaintLayer && (
                <Layer ref={inpaintLayerRef}>
                  <KonvaImage image={inpaintedImage.bitmap} x={0} y={0} />
                </Layer>
              )}
            </Stage>
          </div>
        </div>
      </div>
      <ScaleControl onZoom={applyZoom} onReset={fitAndCenter} />
    </>
  )
}

export default Canvas
