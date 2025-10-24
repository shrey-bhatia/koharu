# Detection Interaction Review

## Interaction Flow (What the code currently does)
- `next/components/canvas.tsx` wires every detection rectangle (`Rect`) as an uncontrolled Konva node: dragging and resizing mutate the Konva instance immediately, while the canonical `textBlocks` array is only rewritten in `onDragEnd` and `onTransformEnd`.
- Stage panning is governed by a `lockStage` helper that disables `Stage.draggable` only after a region emits `dragstart`/`transformstart`, and re-enables it on the corresponding `end` callbacks.
- Visual adornments (the red corner dot and numeric label) are separate Konva shapes driven purely by `textBlocks`, so they only update once the React state is replaced.
- Transformer visibility is coupled to the `isZooming` flag; any wheel gesture hides the handles until 300 ms after the gesture stops.
- Selection state is tracked by `selectedBlockIndex` (plain array index). The detection panel’s sliders, buttons, and re-run logic replace the entire `textBlocks` array without touching the selection.

## User-Experience Findings

1. **Labels and dots lag behind the rectangle being edited.** Because `Circle`/`Text` overlays in `next/components/canvas.tsx` depend on `textBlocks` updates that fire only on `dragEnd`/`transformEnd`, they stay frozen at the pre-edit position while the box is moving. This looks like the selection is “ghosting” and makes it hard to judge where the true bounds are mid-drag.
2. **Transformer handles flicker or disappear during common zoom gestures.** The handles are hidden whenever `isZooming` is true, and that flag stays high for 300 ms after *each* wheel event. Trackpads emit a burst of wheel events, so the transformer can vanish for the entire edit session, forcing users to wait for handles to come back before continuing.
3. **Stage panning competes with block edits on the first pointer movement.** `lockStage(true)` only runs in `onDragStart`/`onTransformStart`, so the Stage remains draggable during the pointer-down and the initial few pixels of movement. On high-sensitivity mice or touch, that initial movement can exceed the stage’s `dragDistance`, causing the background to start sliding before the lock kicks in.
4. **Selection sensitivity slider is a placebo.** The detection panel exposes a slider that promises hit-area adjustment, yet `selectionSensitivity` is never used when computing `hitStrokeWidth` (the code now relies on `screenSpace`). Users tweak the slider, see zero difference, and conclude the editor is unreliable.
5. **Handles are physically obstructed.** The red numbering badge is rendered exactly where the top-left transformer handle appears, and the `Transformer` padding pushes the grab points a few pixels off the box. This combination makes it genuinely hard to grab corners, especially on dense pages.
6. **No bounds checking means blocks can vanish off-canvas.** Dragging or resizing past the image edges lets rectangles disappear into negative space. Recovering them then requires manual value tweaks or undo, which feels hostile compared to the otherwise guided zoom/pan experience.

## Code-Level Bugs and Debugging Risks

1. **State races on drag end.** Both `onDragEnd` and `handleTransformEnd` call `setTextBlocks(textBlocks.map(...))` with the array captured when the handler was created. If detection, OCR, or another panel replaces `textBlocks` while the user is mid-drag, the late-arriving `map` will overwrite those newer changes. There’s no functional setter or diff merge, so edits silently disappear.
2. **Selection survives data refresh with mismatched targets.** When detection is re-run, `setTextBlocks(blocks)` replaces the array but `selectedBlockIndex` is left untouched. If the new results have fewer items or a different order, the transformer will either attach to the wrong rectangle or fail to find one, leaving the UI in an inconsistent state with stale selection cues.
3. **Stage lock can get stuck after aborted gestures.** The only unlock paths are `dragend`, `transformend`, toggling tools, or clicking the canvas background. Pointer cancellations (Escape key, window blur, touch cancel) do not trigger these callbacks, so the stage can remain non-draggable until the user discovers the manual reset.
4. **Overlay artefacts complicate debugging.** Because the label/dot shapes reflect *previous* state, any logging tied to `textBlocks` won’t match what users see during a drag. This disconnect makes it harder to reason about reported bugs—logs say “box at X=100,” but the on-screen rectangle is already at X=130.
5. **Zoom instrumentation obscures interaction timing.** The transformer redraw debounce relies on `isZooming` and `transformerDebounceRef`. When handles fail to appear, there’s no tracing to reveal whether the redraw was skipped, making reproduction and diagnosis unnecessarily opaque.

## Why the Interaction Feels Worse Than Zooming
- Zoom/pan logic is cohesive: scale, position, and gesture throttling all share a single flow with predictable feedback. In contrast, detection editing involves three desynchronised systems (Konva node state, React `textBlocks`, and overlay adornments) that update at different times, so visual cues fight each other.
- Latent locks and disappearing handles amplify uncertainty—users don’t know whether the app ignored input or is waiting for an internal timer. The need to reorient after every wheel flick compounds frustration.
- Debugging aids (logs, selection counters, slider controls) promise control but fail to reflect reality, eroding trust.

## Recommendations (directional, no code)
- Group the rectangle, label, and badge into a single Konva `Group` so every visual element moves together while Konva handles the drag/transform.
- Replace index-based selection with stable IDs on `textBlocks`, and clear selection whenever a new detection payload arrives.
- Use functional `setTextBlocks` updates (or Immer in the store) inside drag/resize handlers to avoid overwriting concurrent mutations.
- Lock the stage at pointer down (and unlock on pointer up/cancel) via explicit pointer handlers, and add a defensive unlock on `pointercancel`/`visibilitychange`.
- Drive `hitStrokeWidth` from `selectionSensitivity` again, or remove the control until it does something measurable.
- Add optional logging or dev mode overlays that show when the transformer is attached and why it might be hidden, aiding future debugging.
