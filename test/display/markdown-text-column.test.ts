import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { FontMetricsTable } from "../../src/display/font-metrics"
import { themedTextPlain } from "../../src/display/themed-text"
import { markdownDisplayFilter, markdownParseHeadings } from "../../plugins/markdown"
import { resetFace } from "../../src/runtime/faces"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/markdown"

class EmMetrics extends FontMetricsTable {
  override advance(ch: string, spec: Parameters<FontMetricsTable["advance"]>[1]): number {
    return ch === "\u200b" ? 0 : spec.px * 0.6
  }
  override averageWidth(spec: Parameters<FontMetricsTable["averageWidth"]>[0]): number {
    return spec.px * 0.6
  }
}

const DOC = [
  "---",
  "title: Atlas",
  "tags: [a, b]",
  "---",
  "",
  "# Title",
  "",
  "> quoted text",
  "",
  "---",
  "",
  "- [ ] todo",
  "",
  "```ts",
  "code()",
  "```",
  "",
].join("\n")

function setup() {
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", DOC, "markdown")
  buffer.locals.set("markdown-hide-markup", true)
  buffer.point = 0
  return { editor, buffer }
}

const gui = () => ({ unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true, fontMetrics: new EmMetrics() })
const tui = { unit: "cells" as const, mouse: true, clipboard: true, osc52: false }

test("front matter is metadata, not a setext heading", () => {
  const headings = markdownParseHeadings(DOC)
  expect(headings.map(h => h.title)).toEqual(["Title"])
})

test("GUI text column: rows carry kinds and CSS draws the rule and quote bar", () => {
  const { editor } = setup()
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 60, cols: 100 }, hostCapabilities: gui() })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rows = themedTextPlain(pane!.body).split("\n")
  const kinds = pane!.rowDecorations!.map(d => d?.kind)
  expect(kinds.slice(0, 4)).toEqual(["frontmatter", "frontmatter", "frontmatter", "frontmatter"])
  const at = (kind: string) => rows[kinds.indexOf(kind)]
  expect(at("heading-1")).toBe("Title")
  expect(at("quote")).toBe("quoted text")
  expect(at("hr")).toBe("")
  expect(kinds).toContain("code-fence-open")
  expect(kinds).toContain("code")
  expect(rows.some(r => r.includes("\u25a2 todo"))).toBe(true)
  expect(kinds[rows.findIndex(r => r.includes("\u25a2 todo"))]).toBe("list-0")
  // Space above the heading is part of the row geometry the kernel costs.
  expect(pane!.rowDecorations![kinds.indexOf("heading-1")]!.padTopPx).toBeGreaterThan(0)
})

test("GUI list items: indent and nesting guides are in ems of the body font, so they scale with it", () => {
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("list.md", "- top\n\t- child\n        - grandchild\n- [ ] task\n", "markdown")
  buffer.locals.set("markdown-hide-markup", true)
  buffer.point = 0
  const decorations = (scale: number) => {
    buffer.locals.set("text-scale-mode-amount", scale)
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 60, cols: 100 }, hostCapabilities: gui() })
    const pane = model.windows.kind === "leaf" ? model.windows.pane : null
    return { rows: themedTextPlain(pane!.body).split("\n"), decorations: pane!.rowDecorations! }
  }
  const base = decorations(0)
  // A tab and 8 spaces are one nesting level each (CommonMark), and the source
  // indent is hidden: the row inset draws it.
  expect(base.decorations.slice(0, 4).map(d => d?.kind)).toEqual(["list-0", "list-1", "list-2", "list-0"])
  expect(base.rows[1]).toBe("\u26ac child")
  const [top, child, grandchild] = base.decorations as NonNullable<typeof base.decorations[number]>[]
  expect(child!.insetPx! - top!.insetPx!).toBe(grandchild!.insetPx! - child!.insetPx!)
  expect(top!.guides).toBeUndefined()
  expect(grandchild!.guides!.count).toBe(2)
  // Twice the text scale steps doubles the inset, the guide step and the font.
  const zoomed = decorations(4).decorations as typeof base.decorations
  const ratio = 1.2 ** 4
  expect(zoomed[1]!.insetPx! / child!.insetPx!).toBeCloseTo(ratio, 1)
  expect(zoomed[2]!.guides!.stepPx / grandchild!.guides!.stepPx).toBeCloseTo(ratio, 1)
})

test("TUI keeps the glyph rule, quote bar and bullets", () => {
  const { editor, buffer } = setup()
  buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 60, cols: 100 }, hostCapabilities: tui })
  const text = markdownDisplayFilter(buffer)!.text
  expect(text).toContain("\u258c quoted text")
  expect(text).toContain("\u2500\u2500\u2500")
  expect(text).toContain("\u25cf [ ] todo")
  expect(markdownDisplayFilter(buffer)!.lineKinds).toBeUndefined()
})

test("C-n walks every row of a decorated GUI document without skipping lines", async () => {
  const { editor, buffer } = setup()
  buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 60, cols: 100 }, hostCapabilities: gui() })
  const seen: number[] = []
  for (let i = 0; i < 20 && buffer.lineAt(buffer.point) < buffer.lineCount - 1; i++) {
    seen.push(buffer.lineAt(buffer.point))
    await editor.run("next-line")
  }
  // Every line is visited once: no row wraps here, and none is skipped.
  expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i))
})
