import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import type { HostCapabilities } from "./protocol"
import type { DisplayModel } from "./protocol"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"
import { setEditorDisplayContext } from "./scroll"
import { paneWrapLayoutFor } from "./display-wrap"
import { computeLineVisualRows, computeWrappedLineRows, hasNonUnitVisualRows, visualRowLineRange } from "./visual-line-height"
import { buildLogicalModel, pointLineCol, type LogicalPane, type LogicalWindowNode } from "./logical"
import { layoutCharGrid, splitColBudget, splitLineBudget } from "./char-grid-layout"
import { PIXEL_DISPLAY_LOCAL, pixelRowCounts, pixelWrapFor } from "./pixel-wrap"
import { fitRightMargin } from "./right-margin"

export type BuildDisplayOptions = {
  lastMessage?: string
  viewport: ViewportSize
  hostLabel?: string
  hostCapabilities?: HostCapabilities
  /** Render this frame instead of the selected one (multi-frame GUI hosts). */
  frameId?: string
}

/** `Editor` → `DisplayModel` for char-grid hosts (OpenTUI / Electron).
 *  Shim: editor side-effects + `buildLogicalModel` → `layoutCharGrid`. */
export function buildDisplayModel(editor: Editor, options: BuildDisplayOptions): DisplayModel {
  const { viewport, lastMessage, hostLabel, hostCapabilities, frameId } = options
  setEditorDisplayContext(editor, viewport, hostCapabilities)
  markPixelDisplayBuffers(editor, hostCapabilities)
  const logical = buildLogicalModel(editor, { lastMessage, hostLabel, frameId })
  const selected = syncEditorWindowGeometry(editor, logical, viewport)
  const model = layoutCharGrid(logical, viewport, hostCapabilities)
  // Write the selected window's corrected `startLine` back to the editor.
  // `layoutCharGrid` derives the same value internally for rendering; this is
  // the persistence half so the next frame / scroll command sees it. Runs
  // *after* the logical build so `LogicalPane.startLine` matches the wrap
  // input the legacy path used for visual-row weighting.
  if (selected) {
    const visualRows = selectedVisualRows(
      editor,
      selected.pane,
      selected.maxLines,
      selected.cols,
      hostCapabilities,
    )
    editor.syncSelectedWindowViewport(selected.maxLines, visualRows)
  }
  return model
}

/**
 * Tell each visible buffer whether it is drawn by a host that measures fonts
 * (`PIXEL_DISPLAY_LOCAL`). Set before the logical build, because the markdown
 * display filter reads it: CSS draws a GUI rule and quote bar, so the filter
 * must not emit glyphs for them there. The TUI keeps the glyphs.
 */
function markPixelDisplayBuffers(editor: Editor, hostCapabilities: HostCapabilities | undefined): void {
  const pixel = hostCapabilities?.perFaceFonts === true && hostCapabilities.fontMetrics != null
  for (const buffer of editor.buffers.values()) {
    if (pixel) buffer.locals.set(PIXEL_DISPLAY_LOCAL, true)
    else if (buffer.locals.has(PIXEL_DISPLAY_LOCAL)) buffer.locals.delete(PIXEL_DISPLAY_LOCAL)
  }
}

type SelectedLeaf = { pane: LogicalPane; maxLines: number; cols?: number }

/** Walk the logical window tree with the same row/col split as `layoutCharGrid`
 *  and stamp each leaf's body geometry onto its own `pane.locals` snapshot, so
 *  every split sees the dimensions it will actually render with. The live
 *  `buffer.locals` is updated once per buffer (selected window's geometry wins)
 *  for `window-configuration-change-hook` consumers like terminal panes.
 *  Returns the selected leaf for the post-layout viewport sync. */
function syncEditorWindowGeometry(
  editor: Editor,
  logical: ReturnType<typeof buildLogicalModel>,
  viewport: ViewportSize,
): SelectedLeaf | null {
  const completionLines = logical.completion?.text
    ? Math.max(1, logical.completion.text.split("\n").length)
    : 0
  const areaLines = Math.max(2, contentAreaLines(viewport.rows) - completionLines - logical.overlayRows - (logical.tabBar ? 1 : 0))
  let selected: SelectedLeaf | null = null
  const published = new Set<string>()
  walk(logical.windows, areaLines, viewport.cols)
  return selected

  function walk(node: LogicalWindowNode, lines: number, cols?: number): void {
    if (node.kind === "leaf") {
      const { pane } = node
      const bodyAndFooterLines = windowBodyLines(lines)
      const maxLines = Math.max(1, bodyAndFooterLines - footerLineCount(pane.footer?.text, bodyAndFooterLines))
      const isSelected = node.id === logical.selectedWindowId
      stampPaneGeometry(pane, maxLines, cols, viewport.cols)
      // Per-buffer side effect: selected window's geometry takes precedence so
      // a non-selected split walked later cannot overwrite it (t-audit2-fb76fc34).
      if (isSelected || !published.has(pane.bufferId)) {
        published.add(pane.bufferId)
        const buffer = editor.buffers.get(pane.bufferId)
        // Like Emacs `window-body-width`, the published width excludes the
        // right margin, so visual-line motion and scroll costs wrap the same
        // column the layout draws.
        if (buffer) syncWindowBodyGeometry(editor, buffer, maxLines, textColsFor(pane, cols ?? viewport.cols))
      }
      if (isSelected) selected = { pane, maxLines, cols }
      return
    }
    const lb = splitLineBudget(lines, node.direction, node.ratio)
    const cb = splitColBudget(cols, node.direction, node.ratio)
    walk(node.first, lb.first, cb.first)
    walk(node.second, lb.second, cb.second)
  }
}

function textColsFor(pane: LogicalPane, cols: number | undefined): number | undefined {
  const margin = fitRightMargin(pane.rightMargin, cols)
  return margin && cols != null ? cols - margin.width : cols
}

function footerLineCount(text: string | undefined, bodyAndFooterLines: number): number {
  if (!text) return 0
  return Math.min(Math.max(0, bodyAndFooterLines - 1), Math.max(1, text.split("\n").length))
}

/** Write this leaf's body geometry into the per-pane locals snapshot so
 *  downstream layout / serialization see per-window dimensions, independent of
 *  the buffer-level publish (t-audit2-d032ccb4). */
function stampPaneGeometry(pane: LogicalPane, rows: number, cols: number | undefined, fallbackCols?: number): void {
  if (!pane.buffer) return
  const locals = pane.locals as Map<string, unknown>
  locals.set("window-body-rows", Math.max(1, rows))
  locals.set("window-body-cols", Math.max(1, cols ?? fallbackCols ?? 80))
}

function selectedVisualRows(editor: Editor, pane: LogicalPane, maxLines: number, cols: number | undefined, hostCapabilities: HostCapabilities | undefined): number[] | undefined {
  const useFontMetrics = hostCapabilities?.perFaceFonts === true
  const dText = pane.displayText
  const map = pane.displayMap
  const dPoint = map ? map(pane.point) : pane.point
  const cursorLine = pointLineCol(dText, dPoint).line - 1
  const displayLines = dText.split("\n")
  const lineRange = visualRowLineRange(pane.startLine, cursorLine, maxLines, displayLines.length)
  // Match `layoutLeafPane`: a right margin narrows the wrap column.
  const textCols = textColsFor(pane, cols)
  const wrapLayout = paneWrapLayoutFor(
    dText,
    pane.locals,
    textCols,
    pane.showLineNumbers || Boolean(pane.gutterDecorations?.length),
    pane.startLine,
    maxLines,
    cursorLine + 1,
  )
  if (!useFontMetrics) {
    const wrappedRows = computeWrappedLineRows(displayLines, {
      wrapCols: wrapLayout.wrapCols,
      gutterPrefixLen: wrapLayout.gutterPrefixLen,
      wordWrap: wrapLayout.wordWrap,
      adaptiveWrap: wrapLayout.adaptiveWrap,
      fromLine: lineRange.fromLine,
      toLine: lineRange.toLine,
    })
    return hasNonUnitVisualRows(wrappedRows) ? wrappedRows : undefined
  }
  if (!pane.buffer) return undefined
  const dFontLockSpans = map
    ? pane.fontLockSpans.map(s => ({ ...s, start: map(s.start), end: map(s.end) }))
    : pane.fontLockSpans
  // The same pixel wrap `layoutLeafPane` uses, so the persisted `startLine`
  // and the rendered one agree (see `JemacsHostBinding.modelFor`).
  const showGutter = pane.showLineNumbers || Boolean(pane.gutterDecorations?.length)
  const pixel = pixelWrapFor({
    locals: pane.locals,
    cols: textCols,
    showGutter,
    perFaceFonts: true,
    metrics: hostCapabilities?.fontMetrics,
    theme: editor.theme,
    buffer: pane.buffer,
    textScale: pane.textScale,
  })
  return computeLineVisualRows(dText, dFontLockSpans, editor.theme, pane.buffer, pane.textScale, {
    wrapCols: wrapLayout.wrapCols,
    gutterPrefixLen: wrapLayout.gutterPrefixLen,
    wordWrap: wrapLayout.wordWrap,
    adaptiveWrap: wrapLayout.adaptiveWrap,
    displayLines,
    fromLine: lineRange.fromLine,
    toLine: lineRange.toLine,
    ...(pixel ? { ...pixelRowCounts(pixel, displayLines, dFontLockSpans, lineRange.fromLine, lineRange.toLine, pane.displayLineKinds, pane.displayLineImages), lineHeight: pixel.lineHeight } : {}),
  })
}

function syncWindowBodyGeometry(editor: Editor, buffer: BufferModel, rows: number, cols?: number): void {
  const safeRows = Math.max(1, rows)
  const safeCols = Math.max(1, cols ?? 80)
  const oldRows = buffer.locals.get("window-body-rows")
  const oldCols = buffer.locals.get("window-body-cols")
  if (oldRows === safeRows && oldCols === safeCols) return
  buffer.locals.set("window-body-rows", safeRows)
  buffer.locals.set("window-body-cols", safeCols)
  void editor.runHook("window-configuration-change-hook", buffer)
}

export { buildLogicalModel } from "./logical"
export { layoutCharGrid } from "./char-grid-layout"
