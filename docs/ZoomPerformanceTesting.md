# Zoom Performance Testing Guide

**Version:** 1.0
**Date:** 2025-10-24
**Application:** Koharu v0.1.11+

---

## Overview

This guide provides step-by-step instructions for collecting performance metrics before and after zoom optimizations. Follow these procedures to ensure consistent, reproducible measurements.

---

## Prerequisites

### Test Images

Prepare three test images in different size categories:

| Category | Resolution | Purpose | Example Source |
|----------|------------|---------|----------------|
| Baseline | 1057×1500 | Reference performance | Typical manga page |
| Large | 3000×4500 | Real-world stress test | High-quality scan |
| Stress | 8000×12000 | Extreme case | Ultra high-res scan |

**Download/Prepare:**
```bash
# Create test images directory
mkdir -p test-images

# If using sample images:
# - baseline.png (1057×1500)
# - large.png (3000×4500)
# - stress.png (8000×12000)
```

### Hardware Profiles

Test on at least two hardware configurations:

1. **Integrated GPU:** Intel UHD 620 or equivalent
2. **Discrete GPU:** NVIDIA GTX 1060 or better

Record system specs:
```
CPU: _______________
RAM: _______________
GPU: _______________
Display: ___________ (resolution + refresh rate)
OS: _______________
```

---

## Test Procedures

### Phase 1: Baseline Metrics (Before Optimizations)

#### 1.1 Enable Performance Monitoring

Open browser DevTools (F12), switch to **Performance** tab.

**Optional:** Enable metrics in app:
```javascript
// In browser console:
localStorage.setItem('zoom_metrics', 'true')
// Reload page
```

#### 1.2 Button Click Zoom Test

**Steps:**
1. Load baseline image (1057×1500)
2. Reset zoom to 100%: Click percentage display
3. Start DevTools recording
4. Click zoom-out button 9 times (100% → 55%)
5. Click zoom-in button 18 times (55% → 145%)
6. Stop recording
7. Export performance profile as `baseline-button-small.json`

**Repeat for:**
- Large image (3000×4500) → `baseline-button-large.json`
- Stress image (8000×12000) → `baseline-button-stress.json`

**Record:**
| Image Size | Avg Frame Time | P95 Frame Time | Scripting Time | Rendering Time |
|------------|----------------|----------------|----------------|----------------|
| 1057×1500  | _____ ms       | _____ ms       | _____ ms       | _____ ms       |
| 3000×4500  | _____ ms       | _____ ms       | _____ ms       | _____ ms       |
| 8000×12000 | _____ ms       | _____ ms       | _____ ms       | _____ ms       |

#### 1.3 Mouse Wheel Zoom Test (if implemented)

**Steps:**
1. Load large image (3000×4500)
2. Reset zoom to 100%
3. Start DevTools recording
4. Continuously scroll mouse wheel down for 2 seconds (zoom out)
5. Continuously scroll mouse wheel up for 2 seconds (zoom in)
6. Stop recording
7. Export profile as `baseline-wheel-large.json`

**Count in DevTools:**
- Number of `setScale()` calls during 4-second gesture
- Total gesture duration
- Average frame time

**Record:**
| Metric | Value |
|--------|-------|
| Total wheel events fired | _____ |
| Total scale updates | _____ |
| Total gesture duration | _____ ms |
| Avg frame time | _____ ms |
| P95 frame time | _____ ms |
| Frames below 16ms (60fps) | _____ % |
| Frames below 33ms (30fps) | _____ % |

#### 1.4 Keyboard Zoom Test

**Steps:**
1. Load large image (3000×4500)
2. Reset zoom to 100%
3. Start DevTools recording
4. Press Ctrl/Cmd + Minus 10 times
5. Press Ctrl/Cmd + Plus 10 times
6. Press Ctrl/Cmd + 0 (reset)
7. Stop recording
8. Export profile as `baseline-keyboard-large.json`

**Record:**
| Metric | Value |
|--------|-------|
| Total operations | 21 |
| Avg frame time | _____ ms |
| P95 frame time | _____ ms |

---

### Phase 2: Enable Optimizations

#### 2.1 Activate Feature Flag

In browser console or settings UI:
```javascript
localStorage.setItem('zoom_optimizations', 'true')
localStorage.setItem('zoom_metrics', 'true')
// Reload page
```

#### 2.2 Verify Optimization Active

Check console for log messages:
```
[Zoom Performance] { totalDuration: "X.XXms", renderCount: X, ... }
```

If present, optimizations are active.

---

### Phase 3: Optimized Metrics (After Optimizations)

Repeat **all tests from Phase 1** with optimizations enabled.

**File naming convention:**
- `optimized-button-small.json`
- `optimized-button-large.json`
- `optimized-button-stress.json`
- `optimized-wheel-large.json`
- `optimized-keyboard-large.json`

**Record in same tables with "Optimized" prefix.**

---

### Phase 4: Console Metrics (if enabled)

When `zoom_metrics` is enabled, console will log:

```
[Zoom Performance] {
  totalDuration: "1234.56ms",
  renderCount: 8,
  avgFrameTime: "15.42ms",
  p95FrameTime: "22.18ms"
}
```

**Copy all console logs to:** `console-metrics.txt`

---

## Analysis

### Calculate Improvements

For each test scenario:

```
Improvement (%) = ((Baseline - Optimized) / Baseline) × 100

Example:
Baseline avg frame time: 28ms
Optimized avg frame time: 22ms
Improvement: ((28 - 22) / 28) × 100 = 21.4%
```

### Success Criteria Checklist

- [ ] Avg frame time < 16ms @ 60fps for baseline image
- [ ] P95 frame time < 33ms @ 30fps for large image
- [ ] Wheel zoom renders/gesture reduced by 60-80%
- [ ] No visual quality regression at 100% zoom
- [ ] No memory leaks (check DevTools Memory tab)

---

## Metrics Summary Template

### Before Optimizations

**Button Zoom:**
| Image | Avg Frame | P95 Frame | Status |
|-------|-----------|-----------|--------|
| Small | ____ ms   | ____ ms   | ⚠️ / ✅ |
| Large | ____ ms   | ____ ms   | ⚠️ / ✅ |
| Stress| ____ ms   | ____ ms   | ⚠️ / ✅ |

**Wheel Zoom:**
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Updates/gesture | ____ | < 10 | ⚠️ / ✅ |
| Avg frame time | ____ ms | < 33ms | ⚠️ / ✅ |

### After Optimizations

**Button Zoom:**
| Image | Avg Frame | P95 Frame | Improvement |
|-------|-----------|-----------|-------------|
| Small | ____ ms   | ____ ms   | ____ % |
| Large | ____ ms   | ____ ms   | ____ % |
| Stress| ____ ms   | ____ ms   | ____ % |

**Wheel Zoom:**
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Updates/gesture | ____ | ____ | ____ % |
| Avg frame time | ____ ms | ____ ms | ____ % |

---

## Visual Quality Verification

### Test 1: 100% Actual Pixels

**Steps:**
1. Load large image (3000×4500)
2. Zoom to 100%
3. Screenshot a 500×500px region containing text
4. Save as `quality-before-100pct.png`
5. Enable optimizations
6. Repeat steps 2-3
7. Save as `quality-after-100pct.png`
8. Compare pixel-by-pixel (should be identical)

**Result:** ✅ Identical / ❌ Differences found

### Test 2: 50% Zoom Quality

Repeat Test 1 at 50% zoom.

**Result:** ✅ Identical / ❌ Differences found

### Test 3: 200% Zoom Quality

Repeat Test 1 at 200% zoom.

**Result:** ✅ Identical / ❌ Differences found

---

## Troubleshooting

### Optimizations Not Working

**Symptom:** No console logs, no performance change

**Check:**
```javascript
// In console:
console.log(localStorage.getItem('zoom_optimizations'))
// Should output: "true"

// Check state:
const state = window.__ZUSTAND_STORE__?.getState?.()
console.log(state?.zoomOptimizationsEnabled)
// Should output: true
```

**Fix:** Clear localStorage and re-enable:
```javascript
localStorage.removeItem('zoom_optimizations')
localStorage.setItem('zoom_optimizations', 'true')
location.reload()
```

### Inconsistent Results

**Symptom:** Frame times vary wildly between runs

**Solutions:**
1. Close other browser tabs
2. Disable browser extensions
3. Run 3 trials, use median values
4. Ensure GPU acceleration is enabled (chrome://gpu)

### Performance Regression

**Symptom:** Optimized version is slower

**Check:**
1. Verify feature flag is actually enabled
2. Check for excessive console logging (disable in production)
3. Profile with DevTools to identify bottleneck
4. Report issue with profile dumps

**Rollback:**
```javascript
localStorage.setItem('zoom_optimizations', 'false')
location.reload()
```

---

## Reporting

### Report Template

```markdown
## Zoom Performance Test Results

**Date:** YYYY-MM-DD
**Tester:** ___________
**Hardware:** ___________ (CPU/GPU)
**Browser:** ___________ (version)

### Test Images
- Baseline: 1057×1500 (size: ___ MB)
- Large: 3000×4500 (size: ___ MB)
- Stress: 8000×12000 (size: ___ MB)

### Results Summary

#### Button Zoom Performance
| Image Size | Before (avg) | After (avg) | Improvement |
|------------|--------------|-------------|-------------|
| Baseline   | ___ ms       | ___ ms      | ___ %       |
| Large      | ___ ms       | ___ ms      | ___ %       |
| Stress     | ___ ms       | ___ ms      | ___ %       |

#### Wheel Zoom Performance
| Metric              | Before | After | Improvement |
|---------------------|--------|-------|-------------|
| Updates/gesture     | ___    | ___   | ___ %       |
| Avg frame time (ms) | ___    | ___   | ___ %       |
| P95 frame time (ms) | ___    | ___   | ___ %       |

### Visual Quality
- [x] / [ ] 100% zoom: Pixel-perfect match
- [x] / [ ] 50% zoom: No quality loss
- [x] / [ ] 200% zoom: No quality loss

### Recommendations
- ✅ / ❌ Enable optimizations by default
- ✅ / ❌ Requires further tuning
- ✅ / ❌ Rollback recommended

### Notes
___________________________________________
___________________________________________
```

---

## Continuous Monitoring

### Add to CI/CD (Future)

**Automated Performance Regression Tests:**
```javascript
// Example Playwright test
test('zoom performance regression', async ({ page }) => {
  await page.goto('/editor')
  await page.locator('input[type="file"]').setInputFiles('test-images/large.png')

  // Start performance measurement
  const metrics = await page.evaluate(() => {
    performance.mark('zoom-test-start')
    // Simulate zoom operations
    for (let i = 0; i < 10; i++) {
      document.querySelector('[aria-label="Zoom in"]').click()
    }
    performance.mark('zoom-test-end')
    performance.measure('zoom-test', 'zoom-test-start', 'zoom-test-end')
    return performance.getEntriesByName('zoom-test')[0].duration
  })

  expect(metrics).toBeLessThan(500) // 500ms for 10 clicks
})
```

---

## Appendix: Quick Reference

### Feature Flags
```javascript
// Enable optimizations
localStorage.setItem('zoom_optimizations', 'true')

// Enable metrics logging
localStorage.setItem('zoom_metrics', 'true')

// Disable (rollback)
localStorage.setItem('zoom_optimizations', 'false')

// Check status
console.log(localStorage.getItem('zoom_optimizations'))
```

### Keyboard Shortcuts
- **Ctrl/Cmd + Plus:** Zoom in
- **Ctrl/Cmd + Minus:** Zoom out
- **Ctrl/Cmd + 0:** Reset to 100%

### Performance Marks
```javascript
// Check if marks are being recorded
performance.getEntriesByType('mark').filter(m => m.name.startsWith('zoom:'))
```

---

**Document Version:** 1.0
**Last Updated:** 2025-10-24
**Next Review:** After Phase 3 testing
