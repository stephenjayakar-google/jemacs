import type { BufferModel } from "../kernel/buffer"
import type { FaceName, TextSpan } from "../modes/mode"
import { mergeFaceStyles, resolveFace } from "../runtime/faces"
import type { FaceStyle, Theme } from "./theme-types"
import { faceStyleHasVisual } from "./theme-types"
import { plainThemedText, styleToChunk, type ThemedChunk, type ThemedText } from "./themed-text"

export type { FaceStyle, Theme } from "./theme-types"
export { defineTheme } from "./theme-types"

export type ApplyThemeOptions = {
  buffer?: BufferModel
}

export function themeFaceBackground(theme: Theme, face: FaceName = "default"): string | undefined {
  return theme.faces[face]?.bg ?? theme.faces.default?.bg
}

export function applyTheme(text: string, spans: TextSpan[], theme: Theme, options: ApplyThemeOptions = {}): ThemedText {
  const defaultStyle = resolveFace("default", theme, options.buffer)
  if (!spans.length) return plainThemedText(text, defaultStyle)

  const ordered = spans
    .filter(span => span.end > span.start && span.start < text.length)
    .map(span => ({ ...span, start: Math.max(0, span.start), end: Math.min(text.length, span.end) }))
  const boundaries = [...new Set([0, text.length, ...ordered.flatMap(span => [span.start, span.end])])]
    .sort((a, b) => a - b)
  const chunks: ThemedChunk[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!
    const end = boundaries[i + 1]!
    if (start === end) continue
    const style = ordered.reduce<FaceStyle | undefined>((merged, span) => {
      if (span.start > start || span.end < end) return merged
      const faceStyle = withoutDefaultFont(resolveFace(span.face, theme, options.buffer), defaultStyle)
      return mergeFaceStyles(mergeFaceStyles(merged, faceStyle), span.style)
    }, defaultStyle)
    chunks.push(themedChunk(text.slice(start, end), style))
  }
  return { chunks }
}

/**
 * Drop a face's family and height when they are only the default's.
 *
 * Every face inherits the (buffer-remapped) default font so it has one, but in
 * Emacs an attribute a face does not specify never overrides the face below
 * it. Without this the `region` face reset a selected heading or code span to
 * the body font: the text shrank and the row re-wrapped while the mark was
 * active. A default-equal font adds nothing on its own, so dropping it only
 * changes the case where it would have overridden a different font.
 */
function withoutDefaultFont(style: FaceStyle | undefined, defaultStyle: FaceStyle | undefined): FaceStyle | undefined {
  if (!style) return style
  const sameFamily = style.family != null && style.family === defaultStyle?.family
  const sameHeight = style.height != null && style.height === defaultStyle?.height && style.heightScale == null
  if (!sameFamily && !sameHeight) return style
  const out = { ...style }
  if (sameFamily) delete out.family
  if (sameHeight) delete out.height
  return out
}

function themedChunk(text: string, style?: FaceStyle): ThemedChunk {
  if (!faceStyleHasVisual(style)) return { text }
  return { text, ...styleToChunk(style) }
}
