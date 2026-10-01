import type { BufferModel } from "../kernel/buffer"
import type { FaceName } from "../modes/mode"
import { defvar, getCustom } from "../runtime/custom"
import { resolveFace } from "./face-resolve"
import type { Theme } from "./theme"
import { styleToChunk, type ThemedChunk, type ThemedText } from "./themed-text"

/** A note pinned to buffer offset `pos`, drawn in the window's right margin
 *  beside the row that shows `pos`. Notes that collide stack downward. */
export type RightMarginNote = { pos: number; text: string; face?: string }
export type RightMarginSpec = { width: number; notes: RightMarginNote[] }
/** `point` is the window's point (not necessarily `buffer.point` for an
 *  unselected window). Return null to draw nothing. */
export type RightMarginFn = (buffer: BufferModel, point: number) => RightMarginSpec | null

/** Which logical row (offset from the window's start line) a body row shows,
 *  and whether it is that row's first wrapped segment. */
export type RowOrigin = { row: number; first: boolean }

/** Viewport-independent margin: notes resolved to display-text line indices. */
export type LogicalRightMargin = {
  width: number
  notes: Array<{ line: number; text: string; face?: string }>
}

defvar("right-margin-functions", [] as RightMarginFn[],
  "Functions returning right-margin notes for a buffer (see `RightMarginSpec`).")

/** Narrowest text column we keep before dropping the margin entirely. */
const MIN_TEXT_COLS = 40
/** " │ " + "• " */
const NOTE_PREFIX_COLS = 5

/** Collect `right-margin-functions` for `buffer` and map note offsets into
 *  display-text lines. Each function is guarded so one bad plugin can't take
 *  the frame down. */
export function logicalRightMargin(
  buffer: BufferModel,
  point: number,
  displayText: string,
  displayMap?: (n: number) => number,
): LogicalRightMargin | undefined {
  const fns = getCustom<RightMarginFn[]>("right-margin-functions") ?? []
  if (!fns.length) return undefined
  let width = 0
  const raw: RightMarginNote[] = []
  for (const fn of fns) {
    let spec: RightMarginSpec | null
    try { spec = fn(buffer, point) } catch (err) {
      console.error("right-margin function threw:", err)
      continue
    }
    if (!spec) continue
    width = Math.max(width, spec.width)
    raw.push(...spec.notes)
  }
  if (!raw.length || width <= NOTE_PREFIX_COLS) return undefined
  const placed = raw
    .map(note => ({ note, dpos: displayMap ? displayMap(note.pos) : note.pos }))
    .sort((a, b) => a.dpos - b.dpos)
  const notes: LogicalRightMargin["notes"] = []
  let line = 0
  let scan = 0
  for (const { note, dpos } of placed) {
    const limit = Math.min(dpos, displayText.length)
    for (; scan < limit; scan++) if (displayText.charCodeAt(scan) === 10) line++
    notes.push({ line, text: note.text, face: note.face })
  }
  return { width: Math.floor(width), notes }
}

/** Clamp the requested margin to the window; null when the window is too
 *  narrow to spare it. */
export function fitRightMargin(margin: LogicalRightMargin | undefined, cols: number | undefined): LogicalRightMargin | null {
  if (!margin || cols == null) return null
  const width = Math.min(margin.width, Math.floor(cols * 0.4))
  if (width <= NOTE_PREFIX_COLS || cols - width < MIN_TEXT_COLS) return null
  return { ...margin, width }
}

/** Append margin cells to each body row. `origins[k]` says which logical row
 *  (offset from `startLine`) body row `k` belongs to; notes start on the first
 *  wrapped row of their line and push later notes down when they overlap.
 *  Margin chunks are tagged so DOM hosts can position them independently of
 *  variable-pitch text. */
export function appendRightMargin(
  body: ThemedText,
  origins: readonly RowOrigin[],
  startLine: number,
  margin: LogicalRightMargin,
  textCols: number,
  theme: Theme,
  buffer?: BufferModel,
): ThemedText {
  const byLine = new Map<number, LogicalRightMargin["notes"]>()
  for (const note of margin.notes) {
    const list = byLine.get(note.line)
    if (list) list.push(note)
    else byLine.set(note.line, [note])
  }
  const textWidth = margin.width - NOTE_PREFIX_COLS
  const queue: Array<{ bullet: boolean; text: string; style: Omit<ThemedChunk, "text"> }> = []
  const rows = splitRows(body)
  const out: ThemedChunk[] = []
  for (let k = 0; k < rows.length; k++) {
    if (k > 0) out.push({ text: "\n" })
    const row = rows[k]!
    out.push(...row)
    const origin = origins[k]
    if (origin?.first) {
      for (const note of byLine.get(startLine + origin.row) ?? []) {
        const style = styleToChunk(resolveFace((note.face ?? "comment") as FaceName, theme, buffer))
        wrapWords(note.text || "(empty)", textWidth).forEach((text, i) => queue.push({ bullet: i === 0, text, style }))
      }
    }
    const next = queue.shift()
    if (!next) continue
    const used = row.reduce((n, c) => n + cellWidth(c.text), 0)
    if (used < textCols) out.push({ text: " ".repeat(textCols - used), marginPad: true })
    // Pad to the full margin width so DOM hosts (which right-align the
    // chunk) keep every row's bar in the same column.
    out.push({ ...next.style, text: ` │ ${next.bullet ? "•" : " "} ${next.text}`.padEnd(margin.width), margin: true })
  }
  return { chunks: out }
}

function splitRows(body: ThemedText): ThemedChunk[][] {
  const rows: ThemedChunk[][] = [[]]
  for (const chunk of body.chunks) {
    const parts = chunk.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) rows.push([])
      if (parts[i]) rows[rows.length - 1]!.push({ ...chunk, text: parts[i]! })
    }
  }
  return rows
}

function cellWidth(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** Greedy word wrap; words longer than `width` are hard-split. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word
    while (w.length > width) {
      if (line) { lines.push(line); line = "" }
      lines.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!w) continue
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ` ${w}`
    else { lines.push(line); line = w }
  }
  if (line) lines.push(line)
  return lines.length ? lines : [""]
}
