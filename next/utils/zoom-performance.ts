'use client'

/**
 * Performance monitoring utilities for zoom operations
 */

export const PERF_MARKS = {
  ZOOM_START: 'zoom:start',
  ZOOM_END: 'zoom:end',
  WHEEL_START: 'zoom:wheel:start',
  WHEEL_END: 'zoom:wheel:end',
  RENDER_START: 'zoom:render:start',
  RENDER_END: 'zoom:render:end',
} as const

export interface ZoomMetrics {
  totalDuration: number
  renderCount: number
  averageFrameTime: number
  p95FrameTime: number
  timestamp: number
}

class ZoomPerformanceMonitor {
  private enabled = false
  private frameTimes: number[] = []
  private renderCount = 0
  private gestureStartTime = 0

  setEnabled(enabled: boolean) {
    this.enabled = enabled
  }

  startGesture() {
    if (!this.enabled) return
    this.frameTimes = []
    this.renderCount = 0
    this.gestureStartTime = performance.now()
    performance.mark(PERF_MARKS.ZOOM_START)
  }

  recordFrame(duration: number) {
    if (!this.enabled) return
    this.frameTimes.push(duration)
    this.renderCount++
  }

  endGesture(): ZoomMetrics | null {
    if (!this.enabled) return null

    performance.mark(PERF_MARKS.ZOOM_END)

    try {
      performance.measure('zoom-gesture', PERF_MARKS.ZOOM_START, PERF_MARKS.ZOOM_END)
      const measure = performance.getEntriesByName('zoom-gesture')[0]

      const sorted = [...this.frameTimes].sort((a, b) => a - b)
      const p95Index = Math.floor(sorted.length * 0.95)

      const metrics: ZoomMetrics = {
        totalDuration: measure?.duration || 0,
        renderCount: this.renderCount,
        averageFrameTime: sorted.length > 0
          ? sorted.reduce((sum, t) => sum + t, 0) / sorted.length
          : 0,
        p95FrameTime: sorted[p95Index] || 0,
        timestamp: Date.now(),
      }

      // Log to console in dev mode
      if (process.env.NODE_ENV === 'development') {
        console.log('[Zoom Performance]', {
          totalDuration: `${metrics.totalDuration.toFixed(2)}ms`,
          renderCount: metrics.renderCount,
          avgFrameTime: `${metrics.averageFrameTime.toFixed(2)}ms`,
          p95FrameTime: `${metrics.p95FrameTime.toFixed(2)}ms`,
        })
      }

      // Clean up performance entries
      performance.clearMarks(PERF_MARKS.ZOOM_START)
      performance.clearMarks(PERF_MARKS.ZOOM_END)
      performance.clearMeasures('zoom-gesture')

      return metrics
    } catch (error) {
      console.warn('Failed to collect zoom metrics:', error)
      return null
    }
  }

  markWheelStart() {
    if (!this.enabled) return
    performance.mark(PERF_MARKS.WHEEL_START)
  }

  markWheelEnd() {
    if (!this.enabled) return
    performance.mark(PERF_MARKS.WHEEL_END)

    try {
      performance.measure('zoom-wheel', PERF_MARKS.WHEEL_START, PERF_MARKS.WHEEL_END)
      const measure = performance.getEntriesByName('zoom-wheel')[0]

      if (process.env.NODE_ENV === 'development' && measure) {
        console.log(`[Zoom Wheel] ${measure.duration.toFixed(2)}ms`)
      }

      performance.clearMarks(PERF_MARKS.WHEEL_START)
      performance.clearMarks(PERF_MARKS.WHEEL_END)
      performance.clearMeasures('zoom-wheel')
    } catch (error) {
      console.warn('Failed to measure wheel event:', error)
    }
  }
}

export const zoomPerformanceMonitor = new ZoomPerformanceMonitor()

/**
 * Hook for tracking zoom performance in React components
 */
export function useZoomPerformance(enabled: boolean) {
  zoomPerformanceMonitor.setEnabled(enabled)
  return zoomPerformanceMonitor
}
