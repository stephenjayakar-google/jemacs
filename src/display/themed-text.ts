import type { FaceStyle } from "./theme"
import { faceStyleHasVisual } from "./theme-types"

export type ThemedChunk = {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  family?: string
  height?: number
  heightScale?: number
  /** Emacs `:weight` finer than `bold`, e.g. `semi-bold`. DOM hosts only. */
  weight?: string
  /** Emacs `:strike-through`: true, or a line colour. */
  strikeThrough?: boolean | string
  /** Emacs `:overline`: true, or a line colour. DOM hosts only. */
  overline?: boolean | string
  /** `:underline (:style wave :color C)`; `underline` stays the on/off flag. DOM hosts only. */
  underlineStyle?: string
  underlineColor?: string
  /** Emacs `:box`, drawn inside the glyphs so it never changes their width. DOM hosts only. */
  box?: { color?: string; width: number }
  /** Right-margin note cell (see `right-margin.ts`); DOM hosts pin it to the
   *  row's right edge instead of flowing it after the text. */
  margin?: boolean
  /** Spaces that align a margin note on char-grid hosts; DOM hosts skip it. */
  marginPad?: boolean
  /** Clickable margin cell: the note id and action reported on click. */
  marginNote?: string
  marginAction?: string
}

/** Every style field of a chunk, in one place, so merge and cache code cannot miss one. */
export function sameChunkStyle(a: Omit<ThemedChunk, "text">, b: Omit<ThemedChunk, "text">): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic
    && a.underline === b.underline && a.family === b.family && a.height === b.height
    && a.heightScale === b.heightScale && a.weight === b.weight
    && a.strikeThrough === b.strikeThrough && a.overline === b.overline
    && a.underlineStyle === b.underlineStyle && a.underlineColor === b.underlineColor
    && a.box?.color === b.box?.color && a.box?.width === b.box?.width
    && a.margin === b.margin && a.marginPad === b.marginPad
    && a.marginNote === b.marginNote && a.marginAction === b.marginAction
}

export type ThemedText = {
  chunks: ThemedChunk[]
}

export function chunkHasStyle(chunk: ThemedChunk): boolean {
  return faceStyleHasVisual({ ...chunk, box: undefined }) || chunk.box != null
}

export function plainThemedText(text: string, style?: FaceStyle): ThemedText {
  if (!faceStyleHasVisual(style)) return { chunks: [{ text }] }
  return { chunks: [{ text, ...styleToChunk(style) }] }
}

export function styleToChunk(style?: FaceStyle): Omit<ThemedChunk, "text"> {
  if (!style) return {}
  return {
    fg: style.fg,
    bg: style.bg,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    family: style.family,
    height: style.height,
    heightScale: style.heightScale,
    ...(style.weight ? { weight: style.weight } : {}),
    ...(style.strikeThrough ? { strikeThrough: style.strikeThrough } : {}),
    ...(style.overline ? { overline: style.overline } : {}),
    ...(style.underline && style.underlineSpec?.style && style.underlineSpec.style !== "line"
      ? { underlineStyle: style.underlineSpec.style } : {}),
    ...(style.underline && style.underlineSpec?.color && style.underlineSpec.color !== "foreground-color"
      ? { underlineColor: style.underlineSpec.color } : {}),
    ...(style.box ? { box: { width: Math.max(1, Math.abs(style.box.width?.[0] ?? 1)), ...(style.box.color ? { color: style.box.color } : {}) } } : {}),
  }
}

/** Force `italic: false` on the single character at `offset`, splitting the
 *  chunk that contains it.
 *
 *  Char-grid hosts draw the cursor as a `█` inserted into the text, so it picks
 *  up whatever face is under point. In an italic face (comments, markdown
 *  emphasis) the block is slanted, which reads as a rendering glitch rather
 *  than a cursor. */
export function unitalicizeCharAt(model: ThemedText, offset: number): ThemedText {
  if (offset < 0) return model
  const chunks: ThemedChunk[] = []
  let pos = 0
  let done = false
  for (const chunk of model.chunks) {
    const end = pos + chunk.text.length
    if (done || !chunk.italic || offset < pos || offset >= end) {
      chunks.push(chunk)
      pos = end
      continue
    }
    const i = offset - pos
    if (i > 0) chunks.push({ ...chunk, text: chunk.text.slice(0, i) })
    chunks.push({ ...chunk, text: chunk.text.slice(i, i + 1), italic: false })
    if (i + 1 < chunk.text.length) chunks.push({ ...chunk, text: chunk.text.slice(i + 1) })
    done = true
    pos = end
  }
  return { chunks }
}

export function themedTextPlain(model: ThemedText): string {
  return model.chunks.map(c => c.text).join("")
}

/** Cursor placeholder the char-grid layout inserts into body text. */
export const CURSOR_GLYPH = "\u2588"

/** Cursor placeholder for hosts that draw their own caret.
 *
 *  A DOM host paints the caret as an absolutely-positioned overlay, so the
 *  marker only has to survive layout long enough for `extractCursorMarker` to
 *  report `(row, colOffset)`. Using the \u2588 block for that made point occupy a
 *  real column while lines were being wrapped: with point near a wrap boundary
 *  the extra character pushed the last word onto its own row, so the paragraph
 *  reflowed as the user moved the cursor. U+200B is zero-width, so it rides
 *  along through wrapping and padding without changing where a line breaks. */
export const CURSOR_MARKER_ZERO_WIDTH = "\u200b"

/** Pull a `CURSOR_GLYPH` back out of a laid-out body and report where it sat.
 *
 *  Char-grid hosts draw the cursor as a block glyph in the text, which is wrong
 *  on a DOM host: inside a height-scaled heading or a variable-pitch face the
 *  block is a different size than the caret should be, and it displaces the
 *  character it overlays. Hosts with real font metrics instead get a
 *  `(row, colOffset)` and position a caret element themselves. Extracting the
 *  marker *after* layout keeps wrapping and row-budget math on the one code
 *  path both host families share. */
export function extractCursorMarker(
  model: ThemedText,
  marker: string = CURSOR_GLYPH,
): { text: ThemedText; cursor: { row: number; colOffset: number } } | null {
  const chunks: ThemedChunk[] = []
  let cursor: { row: number; colOffset: number } | null = null
  let row = 0
  let col = 0
  for (const chunk of model.chunks) {
    if (cursor) {
      chunks.push(chunk)
      continue
    }
    const at = chunk.text.indexOf(marker)
    const scanned = at < 0 ? chunk.text : chunk.text.slice(0, at)
    for (const ch of scanned) {
      if (ch === "\n") { row++; col = 0 } else col++
    }
    if (at < 0) {
      chunks.push(chunk)
      continue
    }
    cursor = { row, colOffset: col }
    const text = scanned + chunk.text.slice(at + marker.length)
    if (text.length) chunks.push({ ...chunk, text })
  }
  return cursor ? { text: { chunks }, cursor } : null
}
