'use client'

import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Circle,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva'
import ScaleControl from './scale-control'
import { useEditorStore } from '@/lib/state'
import { useZoomPerformance } from '@/utils/zoom-performance'

function Canvas() {
  const {
    tool,
    scale,
    setScale,
    image,
    textBlocks,
    setTextBlocks,
    inpaintedImage,
    segmentationMaskBitmap,
    showSegmentationMask,
    selectedBlockIndex,
    setSelectedBlockIndex,
    currentStage,
    pipelineStages,
    renderMethod,
    selectionSensitivity,
    zoomOptimizationsEnabled,
    zoomMetricsEnabled,
  } = useEditorStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const inpaintLayerRef = useRef<Konva.Layer>(null)
  const stageRef = useRef<Konva.Stage>(null)

  const [selected, setSelected] = useState<Konva.Node | null>(null)
  const [isTouchDevice, setIsTouchDevice] = useState(false)
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 })
  const [isZooming, setIsZooming] = useState(false)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })
  const transformerRef = useRef<Konva.Transformer>(null)
  const safeScale = Math.max(scale, 0.001)

  // Performance monitoring
  const perfMonitor = useZoomPerformance(zoomMetricsEnabled)

  // Optimized zoom state management with rAF batching and pointer anchoring
  const pendingScaleRef = useRef<number | null>(null)
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const wheelTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const transformerDebounceRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    transformerRef.current?.nodes(selected ? [selected] : [])
    transformerRef.current?.getLayer()?.batchDraw()
  }, [selected])

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
    const imgW = image.bitmap.width * clampedScale
    const imgH = image.bitmap.height * clampedScale
    const minX = containerSize.width - imgW
    const minY = containerSize.height - imgH
    const clampedPos = {
      x: Math.min(0, Math.max(minX, newPos.x)),
      y: Math.min(0, Math.max(minY, newPos.y)),
    }

    setScale(clampedScale)
    setStagePos(clampedPos)
  }, [image, containerSize, setScale])

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

  const handleSelectBlock = useCallback(
    (event: KonvaEventObject<Event>, index: number) => {
      event.cancelBubble = true
      setSelectedBlockIndex(index)
      setSelected(event.target as Konva.Node)
    },
    [setSelectedBlockIndex, setSelected]
  )

  // Handler for when a box is transformed (scaled/rotated/resized)
  const handleTransformEnd = (index: number) => {
    const node = selected
    if (!node) return

    const scaleX = node.scaleX()
    const scaleY = node.scaleY()

    // Get the current position after transformation
    const x = node.x()
    const y = node.y()
    const width = node.width() * scaleX
    const height = node.height() * scaleY

    // Reset the scale to 1 (we've already applied it to width/height)
    node.scaleX(1)
    node.scaleY(1)

    // Update state with new dimensions
    const updated = [...textBlocks]
    updated[index] = {
      ...updated[index],
      xmin: x,
      ymin: y,
      xmax: x + width,
      ymax: y + height,
      ocrStale: true, // Mark as stale when resized
    }
    setTextBlocks(updated)
  }

  // Memoized box styles to avoid recalculation on every render
  const boxStyles = useMemo(() => {
    return textBlocks.map((_, index) => ({
      strokeWidth: (selectedBlockIndex === index ? 3 : 2) / safeScale,
      hitStrokeWidth: Math.max(selectionSensitivity / safeScale, 8),
      fontSize: 30 / safeScale,
      radius: 20 / safeScale,
      anchorSize: Math.max((selectionSensitivity * 0.7) / safeScale, 8),
      padding: Math.max((selectionSensitivity * 0.6) / safeScale, 6),
      borderStrokeWidth: Math.max(1 / safeScale, 0.5),
    }))
  }, [textBlocks, selectedBlockIndex, safeScale, selectionSensitivity])

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

  // Visibility guards for layers (only render active layers)
  const showDetectionLayer = tool === 'detection'
  const showRenderRectanglesLayer = shouldShowOverlays && renderMethod === 'rectangle'
  const showRenderTextLayer = tool === 'render' && currentStage === 'final'
  const showSegmentationLayer = tool === 'segmentation'
  const showInpaintLayer = tool === 'inpaint' && inpaintedImage

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
              dragDistance={isTouchDevice ? 10 : 3}
              draggable
              onClick={() => {
                setSelected(null)
                setSelectedBlockIndex(null)
              }}
              onTap={() => {
                setSelected(null)
                setSelectedBlockIndex(null)
              }}
              onDragEnd={(e) => {
                setStagePos({ x: e.target.x(), y: e.target.y() })
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

                    return (
                      <>
                        <Rect
                          key={`rect-${index}`}
                          x={xmin}
                          y={ymin}
                          width={width}
                          height={height}
                          stroke={
                            selectedBlockIndex === index
                              ? 'blue'
                              : block.ocrStale
                                ? 'orange'
                                : 'red'
                          }
                          strokeWidth={styles.strokeWidth}
                          strokeScaleEnabled={false}
                          perfectDrawEnabled={false}
                          hitStrokeWidth={styles.hitStrokeWidth}
                          onClick={(e) => handleSelectBlock(e, index)}
                          onTap={(e) => handleSelectBlock(e, index)}
                          onDragStart={(e) => {
                            setSelectedBlockIndex(index)
                            setSelected(e.target as Konva.Node)
                          }}
                          draggable={true}
                          onDragEnd={(e) => {
                            const updated = [...textBlocks]
                            const newX = e.target.x()
                            const newY = e.target.y()
                            updated[index] = {
                              ...updated[index],
                              xmin: newX,
                              ymin: newY,
                              xmax: newX + width,
                              ymax: newY + height,
                              ocrStale: true, // Mark as stale when moved
                            }
                            setTextBlocks(updated)
                          }}
                          onTransformEnd={() => handleTransformEnd(index)}
                        />
                        <Circle
                          key={`circle-${index}`}
                          x={xmin}
                          y={ymin}
                          radius={styles.radius}
                          fill='rgba(255, 0, 0, 0.7)'
                          listening={false}
                        />
                        <Text
                          key={`text-${index}`}
                          x={xmin - 10 / scale}
                          y={ymin - 15 / scale}
                          text={(index + 1).toString()}
                          fontSize={styles.fontSize}
                          fill='white'
                          fontFamily='sans-serif'
                          listening={false}
                        />
                      </>
                    )
                  })}
                  {selected && !isZooming && (
                    <Transformer
                      ref={transformerRef}
                      nodes={[selected]}
                      anchorSize={boxStyles[selectedBlockIndex ?? 0]?.anchorSize ?? 8}
                      padding={boxStyles[selectedBlockIndex ?? 0]?.padding ?? 6}
                      borderStrokeWidth={boxStyles[selectedBlockIndex ?? 0]?.borderStrokeWidth ?? 0.5}
                    />
                  )}
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
