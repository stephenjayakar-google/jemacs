import { textScaleFactor } from "../core/text-scale"
import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { findWindowLeaf, type WindowNode } from "../kernel/window"
import { defcustom, getCustom } from "../runtime/custom"
import type { HostCapabilities } from "./protocol"
import type { TextSpan } from "../modes/mode"
import { tabBarLines } from "./tab-bar"
import {
  contentAreaLines,
  defaultTerminalRows,
  pageScrollLines,
  windowBodyLines,
  type ViewportSize,
} from "./viewport"
import { displayFilterForBuffer, displayTextForBuffer, paneWrapLayout } from "./display-wrap"
import { computeLineVisualRows, computeWrappedLineRows, hasNonUnitVisualRows, visibleLineCountForBudget } from "./visual-line-height"
import { chunkWidths, pixelRowCounts, pixelRowRanges, pixelWrapFor, rowXOffsets, type PixelWrapLayout } from "./pixel-wrap"
import { applyTheme } from "./theme"

defcustom("next-screen-context-lines", "integer", 2,
  "Lines of overlap left when scrolling by a screenful (C-v / M-v).", "windows")

defcustom("scroll-error-top-bottom", "boolean", false,
  "Move point to top/bottom of buffer before signaling a scrolling error.", "windows")

export class ScrollBoundary extends Error {
  readonly which: "beginning" | "end"
  constructor(which: "beginning" | "end") {
    super(which)
    this.which = which
  }
}

/** `scroll-up-command` (C-v): scroll forward / text moves up. */
export function scrollUpCommand(editor: Editor, arg: number | null): void {
  if (arg != null && arg < 0) {
    scrollDownCommand(editor, -arg)
    return
  }
  runScrollCommand(editor, arg, 1)
}

/** `scroll-down-command` (M-v): scroll backward / text moves down. */
export function scrollDownCommand(editor: Editor, arg: number | null): void {
  if (arg != null && arg < 0) {
    scrollUpCommand(editor, -arg)
    return
  }
  runScrollCommand(editor, arg, -1)
}

/** Viewport-relative line scroll for mouse wheel input; unlike C-v/M-v, it is not point-anchored. */
export function scrollWindowByLines(editor: Editor, lines: number): void {
  const leaf = editor.selectedWindowLeaf()
  if (!leaf) return
  const delta = Number.isFinite(lines) ? Math.trunc(lines) : 0
  if (delta === 0) return

  const buffer = editor.currentBuffer
  const view = displayView(buffer)
  const lineCount = view.text.split("\n").length
  if (lineCount === 0) return

  const bodyBudget = selectedWindowBodyBudget(editor)
  const visualRows = visualRowsForBuffer(editor, buffer)
  const maxStart = maxStartLine(bodyBudget, lineCount, visualRows)
  const newStart = Math.max(0, Math.min(maxStart, leaf.startLine + delta))
  editor.setSelectedWindowStartLine(newStart)

  const oldPointLine = pointLineCol(view.text, view.map(buffer.point)).line - 1
  const visibleAfter = visibleLinesAtStart(newStart, bodyBudget, lineCount, visualRows)
  const topLine = newStart
  const bottomLine = newStart + visibleAfter - 1
  const newPointLine = Math.max(topLine, Math.min(bottomLine, oldPointLine))
  setBufferPointToDisplayLine(buffer, view, newPointLine, pointLineCol(view.text, view.map(buffer.point)).col)
}

function runScrollCommand(editor: Editor, arg: number | null, direction: 1 | -1): void {
  const scrollErrorTopBottom = getCustom<boolean>("scroll-error-top-bottom") ?? false
  try {
    windowScroll(editor, arg, direction)
  } catch (error) {
    if (!(error instanceof ScrollBoundary)) throw error
    if (!scrollErrorTopBottom) {
      editor.message(error.which === "beginning" ? "Beginning of buffer" : "End of buffer")
      return
    }
    const buffer = editor.currentBuffer
    if (error.which === "beginning") {
      if (arg != null) buffer.moveLine(-arg)
      else buffer.moveToBufferStart()
    } else {
      if (arg != null) buffer.moveLine(arg)
      else buffer.moveToBufferEnd()
    }
  }
}

/** Core of Emacs `window_scroll` / `window_scroll_line_based` (line-based path). */
function windowScroll(editor: Editor, prefixArg: number | null, direction: 1 | -1): void {
  const leaf = editor.selectedWindowLeaf()
  if (!leaf) return
  const buffer = editor.currentBuffer
  const view = displayView(buffer)
  const lineCount = view.text.split("\n").length
  if (lineCount === 0) return

  const bodyBudget = selectedWindowBodyBudget(editor)
  const visualRows = visualRowsForBuffer(editor, buffer)
  const context = Math.max(0, getCustom<number>("next-screen-context-lines") ?? 2)
  const whole = prefixArg == null
  const n = whole
    ? direction * Math.max(1, bodyBudget - context)
    : prefixArg! * direction

  const oldPointLine = pointLineCol(view.text, view.map(buffer.point)).line - 1
  const startLine = scrollAnchorStartLine(oldPointLine, bodyBudget, lineCount, visualRows)

  if (n < 0 && startLine === 0) throw new ScrollBoundary("beginning")

  const maxStart = maxStartLine(bodyBudget, lineCount, visualRows)
  const newStart = Math.max(0, Math.min(maxStart, startLine + n))
  const scrolled = newStart - startLine

  if (n > 0 && scrolled === 0 && startLine >= maxStart) throw new ScrollBoundary("end")
  if (n < 0 && scrolled === 0 && startLine === 0) throw new ScrollBoundary("beginning")

  editor.setSelectedWindowStartLine(newStart)

  let newPointLine = oldPointLine
  if (n > 0) {
    const topMargin = newStart
    if (topMargin > oldPointLine) newPointLine = topMargin
  } else if (n < 0) {
    const visibleAfter = visibleLinesAtStart(newStart, bodyBudget, lineCount, visualRows)
    const bottomMargin = newStart + visibleAfter - 1
    if (bottomMargin <= oldPointLine) newPointLine = bottomMargin
  }

  setBufferPointToDisplayLine(buffer, view, newPointLine, pointLineCol(view.text, view.map(buffer.point)).col)
}

export function selectedWindowBodyBudget(editor: Editor): number {
  const viewport = editor.lastViewport ?? { rows: defaultTerminalRows() }
  const areaLines = contentAreaLinesForEditor(editor, viewport)
  const budget = leafBodyBudget(editor.windowLayout, editor.selectedWindowId, areaLines)
  if (budget == null) return pageScrollLines(viewport.rows)
  if (editor.transient?.windowId !== editor.selectedWindowId) return budget
  const footerText = editor.transientDisplayText()
  return Math.max(1, budget - footerLineCount(footerText, budget))
}

function footerLineCount(text: string | null | undefined, bodyAndFooterLines: number): number {
  if (!text) return 0
  return Math.min(Math.max(0, bodyAndFooterLines - 1), Math.max(1, text.split("\n").length))
}

function contentAreaLinesForEditor(editor: Editor, viewport: ViewportSize): number {
  const completionText = editor.minibufferCompletionDisplay?.text
  const completionLines = completionText ? Math.max(1, completionText.split("\n").length) : 0
  const overlayRows = editor.minibuffer ? editor.activeBuffer.text.split("\n").length - 1 : 0
  return Math.max(2, contentAreaLines(viewport.rows) - completionLines - overlayRows - tabBarLines(editor))
}

function leafBodyBudget(layout: WindowNode, leafId: string, availableLines: number): number | null {
  if (layout.kind === "leaf") {
    return layout.id === leafId ? windowBodyLines(availableLines) : null
  }
  const split = splitLineBudget(availableLines, layout.direction, layout.firstRatio)
  return leafBodyBudget(layout.first, leafId, split.first)
    ?? leafBodyBudget(layout.second, leafId, split.second)
}

function splitLineBudget(availableLines: number, direction: "horizontal" | "vertical", firstRatio = 0.5): { first: number; second: number } {
  if (direction === "horizontal") {
    return { first: availableLines, second: availableLines }
  }
  const first = proportionalBudget(availableLines, firstRatio, 3)
  return { first, second: Math.max(3, availableLines - first) }
}

function proportionalBudget(total: number, firstRatio: number, min: number): number {
  if (total <= min * 2) return Math.floor(total / 2)
  const ratio = Math.max(0.05, Math.min(0.95, firstRatio))
  return Math.max(min, Math.min(total - min, Math.floor(total * ratio)))
}

function visualRowsForBuffer(editor: Editor, buffer: BufferModel): number[] | undefined {
  const viewport = editor.lastViewport ?? { rows: defaultTerminalRows() }
  const bodyBudget = selectedWindowBodyBudget(editor)
  const leaf = editor.selectedWindowLeaf()
  const startLine = leaf?.startLine ?? 0
  const showLineNumbers = editor.showLineNumbers(buffer)
  const wrapLayout = paneWrapLayout(buffer, viewport.cols, showLineNumbers, startLine, bodyBudget)
  const displayLines = displayTextForBuffer(buffer).split("\n")
  if (!editor.lastHostCapabilities?.perFaceFonts) {
    const endLine = Math.min(displayLines.length - 1, startLine + Math.max(bodyBudget, 1) + 80)
    const wrappedRows = computeWrappedLineRows(displayLines, {
      wrapCols: wrapLayout.wrapCols,
      gutterPrefixLen: wrapLayout.gutterPrefixLen,
      wordWrap: wrapLayout.wordWrap,
      adaptiveWrap: wrapLayout.adaptiveWrap,
      fromLine: startLine,
      toLine: endLine,
    })
    return hasNonUnitVisualRows(wrappedRows) ? wrappedRows : undefined
  }
  const endLine = Math.min(buffer.lineCount, startLine + Math.max(bodyBudget, 1) + 80)
  const spans = [...editor.fontLock(buffer, {
    startLine,
    endLine,
    start: buffer.lineStarts[startLine] ?? 0,
    end: endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length,
  })]
  const pixel = pixelLayoutForBuffer(editor, buffer)
  // Row costs must use the same wrap as the frame the user sees, or C-v lands
  // point on a line the next redisplay scrolls away from.
  const pixelCosts = pixel
    ? pixelRowCounts(pixel.layout, displayLines, pixel.displaySpans(spans), startLine, Math.min(displayLines.length - 1, endLine), displayFilterForBuffer(buffer)?.lineKinds, displayFilterForBuffer(buffer)?.lineImages)
    : undefined
  return computeLineVisualRows(buffer.text, spans, editor.theme, buffer, textScaleFactor(buffer), {
    wrapCols: wrapLayout.wrapCols,
    gutterPrefixLen: wrapLayout.gutterPrefixLen,
    wordWrap: wrapLayout.wordWrap,
    adaptiveWrap: wrapLayout.adaptiveWrap,
    displayLines,
    ...(pixelCosts ? { ...pixelCosts, lineHeight: pixel!.layout.lineHeight } : {}),
  })
}

/**
 * The pixel wrap the last redisplay used for `buffer`, or null on character-grid
 * hosts and buffers that do not use a text column. `displaySpans` maps
 * buffer-space spans into the display text the wrap measures.
 */
function pixelLayoutForBuffer(editor: Editor, buffer: BufferModel): { layout: PixelWrapLayout; displaySpans: (spans: TextSpan[]) => TextSpan[] } | null {
  const caps = editor.lastHostCapabilities
  if (!caps?.perFaceFonts || !caps.fontMetrics) return null
  const cols = buffer.locals.get("window-body-cols") as number | undefined
  const layout = pixelWrapFor({
    locals: buffer.locals,
    cols,
    showGutter: editor.showLineNumbers(buffer) || editor.gutterDecorations(buffer).length > 0,
    perFaceFonts: true,
    metrics: caps.fontMetrics,
    theme: editor.theme,
    buffer,
    textScale: textScaleFactor(buffer),
  })
  if (!layout) return null
  const map = displayView(buffer).map
  return { layout, displaySpans: spans => spans.map(span => ({ ...span, start: map(span.start), end: map(span.end) })) }
}

/**
 * Emacs `line-move-visual` for a pixel-wrapped text column: `C-n`/`C-p` step one
 * screen row of the frame the user sees, keeping point's horizontal pixel
 * position as the goal (Emacs keeps a goal in pixels too, `temporary-goal-column`
 * scaled by the frame's column width).
 *
 * Returns false when the buffer is not pixel-wrapped, so the caller falls back
 * to the character-grid move.
 */
export function pixelVisualLineMove(editor: Editor, buffer: BufferModel, delta: number): boolean {
  if (delta === 0) return true
  const pixel = pixelLayoutForBuffer(editor, buffer)
  if (!pixel) return false
  const view = displayView(buffer)
  const lines = view.text.split("\n")
  const lineStarts: number[] = []
  for (let i = 0, o = 0; i < lines.length; i++) { lineStarts.push(o); o += lines[i]!.length + 1 }

  const geometry = new Map<number, { rows: Array<[number, number]>; xs: number[] }>()
  const geometryFor = (i: number) => {
    let g = geometry.get(i)
    if (g) return g
    const start = lineStarts[i]!
    const end = start + lines[i]!.length
    const bufStart = view.unmap(start)
    const bufEnd = view.unmap(end)
    // Font-lock a few lines of context: setext headings, fences and front
    // matter are recognised from neighbouring lines.
    const fromLine = Math.max(0, buffer.lineAt(bufStart) - FONT_LOCK_CONTEXT_LINES)
    const toLine = Math.min(buffer.lineCount, buffer.lineAt(bufEnd) + 1 + FONT_LOCK_CONTEXT_LINES)
    const spans = editor.fontLock(buffer, {
      startLine: fromLine,
      endLine: toLine,
      start: buffer.lineStarts[fromLine] ?? 0,
      end: toLine < buffer.lineCount ? buffer.lineStarts[toLine]! : buffer.text.length,
    })
    const lineSpans = pixel.displaySpans([...spans])
      .filter(span => span.end > start && span.start < end)
      .map(span => ({ ...span, start: Math.max(0, span.start - start), end: Math.min(lines[i]!.length, span.end - start) }))
    const rows = pixelRowRanges(pixel.layout, lines[i]!, lineSpans, view.lineKinds?.[i])
    const widths = chunkWidths(applyTheme(lines[i]!, lineSpans, pixel.layout.theme, { buffer }).chunks, pixel.layout)
    g = { rows, xs: rowXOffsets(widths, rows) }
    geometry.set(i, g)
    return g
  }

  const dPoint = view.map(buffer.point)
  let line = lineIndexOf(lineStarts, dPoint)
  let g = geometryFor(line)
  const offset = dPoint - lineStarts[line]!
  // Point on a wrap boundary sits at the start of the continuation row.
  let row = g.rows.findIndex(([start, end]) => offset >= start && offset < end)
  if (row < 0) row = g.rows.length - 1
  const pixelGoal = buffer.locals.get(PIXEL_GOAL) as { point: number; x: number } | undefined
  const goalX = pixelGoal && pixelGoal.point === buffer.point ? pixelGoal.x : (g.xs[offset] ?? 0)

  const step = delta > 0 ? 1 : -1
  let moved = false
  for (let remaining = Math.abs(delta); remaining > 0; remaining--) {
    if (row + step >= 0 && row + step < g.rows.length) row += step
    else if (line + step >= 0 && line + step < lines.length) {
      line += step
      g = geometryFor(line)
      row = step > 0 ? 0 : g.rows.length - 1
    } else break
    moved = true
  }
  if (!moved) {
    editor.message(step > 0 ? "End of buffer" : "Beginning of buffer")
    return true
  }

  const [start, end] = g.rows[row]!
  // The last glyph of a non-final row is the wrap break; Emacs never parks
  // point after it, since that position belongs to the next row.
  const last = row < g.rows.length - 1 ? Math.max(start, end - 1) : end
  let target = start
  for (let i = start; i <= last; i++) {
    if ((g.xs[i] ?? 0) <= goalX + 0.5) target = i
    else break
  }
  buffer.point = view.unmap(lineStarts[line]! + target)
  buffer.locals.set(PIXEL_GOAL, { point: buffer.point, x: goalX })
  return true
}

const FONT_LOCK_CONTEXT_LINES = 3

/** Goal x of the last pixel visual move, valid while point stays where it left it. */
const PIXEL_GOAL = "jemacs-pixel-goal-x"

function lineIndexOf(lineStarts: readonly number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

function visibleLinesAtStart(
  startLine: number,
  bodyBudget: number,
  lineCount: number,
  visualRows?: readonly number[],
): number {
  if (!visualRows?.length) return Math.min(bodyBudget, Math.max(1, lineCount - startLine))
  return visibleLineCountForBudget(startLine, bodyBudget, lineCount, visualRows)
}

function scrollAnchorStartLine(
  pointLine: number,
  bodyBudget: number,
  lineCount: number,
  visualRows?: readonly number[],
): number {
  const cursorLine = Math.max(0, Math.min(lineCount - 1, pointLine))
  const halfWindow = Math.max(0, Math.floor(bodyBudget / 2))
  if (!visualRows?.length) return Math.max(0, Math.min(lineCount - 1, cursorLine - halfWindow))

  let startLine = cursorLine
  let remainingRows = halfWindow
  while (startLine > 0) {
    const previousLineRows = visualRows[startLine - 1] ?? 1
    if (previousLineRows > remainingRows + 1e-6) break
    remainingRows -= previousLineRows
    startLine--
  }
  return startLine
}

// Emacs lets C-v advance until the last line is alone at the top; only signal
// end-of-buffer when already there, don't pre-clamp the step.
function maxStartLine(_bodyBudget: number, lineCount: number, _visualRows?: readonly number[]): number {
  return Math.max(0, lineCount - 1)
}

function displayView(buffer: BufferModel): { text: string; map: (n: number) => number; unmap: (n: number) => number; lineKinds?: ReadonlyArray<string | undefined> } {
  const filter = displayFilterForBuffer(buffer)
  return {
    lineKinds: filter?.lineKinds,
    text: filter?.text ?? buffer.text,
    map: filter?.map ?? ((n: number) => Math.max(0, Math.min(n, buffer.text.length))),
    unmap: filter?.unmap ?? ((n: number) => Math.max(0, Math.min(n, buffer.text.length))),
  }
}

function setBufferPointToDisplayLine(
  buffer: BufferModel,
  view: { text: string; unmap: (n: number) => number },
  lineIndex: number,
  col: number,
): void {
  const lines = view.text.split("\n")
  const targetLine = Math.max(0, Math.min(lines.length - 1, lineIndex))
  let offset = 0
  for (let i = 0; i < targetLine; i++) offset += lines[i]!.length + 1
  buffer.point = view.unmap(Math.max(0, Math.min(view.text.length, offset + Math.min(col - 1, lines[targetLine]!.length))))
}

function pointLineCol(text: string, point: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(point, text.length)))
  const lines = before.split("\n")
  return { line: lines.length, col: lines.at(-1)!.length + 1 }
}

/** @internal */
export function setEditorDisplayContext(
  editor: Editor,
  viewport: ViewportSize,
  hostCapabilities?: HostCapabilities,
): void {
  editor.lastViewport = viewport
  editor.lastHostCapabilities = hostCapabilities
}
