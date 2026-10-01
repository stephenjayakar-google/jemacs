import { createTextAttributes, parseColor, StyledText, type TextChunk } from "@opentui/core"
import type { ThemedChunk, ThemedText } from "../display/themed-text"

/** TUI hosts ignore per-chunk family/height; only color, weight, underline and strike-through are forwarded. */
export function themedTextToStyledText(model: ThemedText): StyledText {
  const chunks: TextChunk[] = model.chunks.map(chunk => themedChunkToTextChunk(chunk))
  return new StyledText(chunks)
}

function themedChunkToTextChunk(chunk: ThemedChunk): TextChunk {
  if (!chunk.fg && !chunk.bg && !chunk.bold && !chunk.italic && !chunk.underline && !chunk.strikeThrough) {
    return { __isChunk: true, text: chunk.text }
  }
  return {
    __isChunk: true,
    text: chunk.text,
    fg: chunk.fg ? parseColor(chunk.fg) : undefined,
    bg: chunk.bg ? parseColor(chunk.bg) : undefined,
    attributes: createTextAttributes({
      bold: chunk.bold,
      italic: chunk.italic,
      underline: chunk.underline,
      strikethrough: Boolean(chunk.strikeThrough),
    }),
  }
}
