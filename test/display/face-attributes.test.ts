import { expect, test } from "bun:test"
import { applyTheme } from "../../src/display/theme"
import { sameChunkStyle, styleToChunk } from "../../src/display/themed-text"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/markdown"

test("styleToChunk carries strike-through, overline, weight, box and underline style", () => {
  const chunk = styleToChunk({
    strikeThrough: true,
    overline: "#f00",
    weight: "semi-bold",
    underline: true,
    underlineSpec: { style: "wave", color: "#0f0", position: null },
    box: { width: [1, 1], color: "#333", style: null },
  })
  expect(chunk).toMatchObject({
    strikeThrough: true,
    overline: "#f00",
    weight: "semi-bold",
    underline: true,
    underlineStyle: "wave",
    underlineColor: "#0f0",
    box: { width: 1, color: "#333" },
  })
  expect(sameChunkStyle(chunk, { ...chunk, strikeThrough: undefined })).toBe(false)
})

test("gfm ~~text~~ renders struck through, not underlined", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", "a ~~gone~~ b\n", "gfm")
  const themed = applyTheme(buffer.text, [...editor.fontLock(buffer)], editor.theme, { buffer })
  const struck = themed.chunks.find(c => c.text.includes("gone"))
  expect(struck?.strikeThrough).toBe(true)
  expect(struck?.underline).toBeFalsy()
})

test("an active region keeps the font of the text under it", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", "# Heading\n\nbody `code`\n", "markdown")
  const spans = [...editor.fontLock(buffer)]
  const plain = applyTheme(buffer.text, spans, editor.theme, { buffer })
  const selected = applyTheme(buffer.text, [...spans, { start: 0, end: buffer.text.length, face: "region" }], editor.theme, { buffer })
  const font = (chunks: typeof plain.chunks, text: string) => {
    const c = chunks.find(ch => ch.text.includes(text))!
    return { family: c.family, height: c.height, heightScale: c.heightScale, bold: c.bold }
  }
  expect(font(selected.chunks, "Heading")).toEqual(font(plain.chunks, "Heading"))
  expect(selected.chunks.find(c => c.text.includes("Heading"))?.bg).toBe(editor.theme.faces.region?.bg)
})
