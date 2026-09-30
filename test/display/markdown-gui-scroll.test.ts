import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { DOM_FRAME_LINE_HEIGHT_RATIO, DOM_FRAME_ROW_PX } from "../../src/display/dom-frame"
import { themedTextPlain } from "../../src/display/themed-text"
import { pageScrollLines } from "../../src/display/viewport"
import { getCustom } from "../../src/runtime/custom"
import { resetFace } from "../../src/runtime/faces"
import { makeEditor } from "../plugins/helper"
import { install } from "../../plugins/markdown"

const guiCaps = { unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true }

test("GUI markdown scroll keeps cursor on screen below tall headings", async () => {
  const editor = makeEditor()
  install(editor)
  const lines = ["# Title"]
  for (let i = 0; i < 40; i++) lines.push(`line ${i}`)
  const buffer = editor.scratch("doc.md", lines.join("\n") + "\n", "markdown")
  buffer.point = buffer.text.length

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 30, cols: 80 },
    hostCapabilities: guiCaps,
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane).not.toBeNull()
  // GUI hosts get a caret coordinate rather than a █ in the text; the row it
  // names still has to be inside the pane's budget and inside the body.
  const bodyRows = themedTextPlain(pane!.body).split("\n")
  const cursorRow = pane!.cursor?.row ?? -1
  expect(cursorRow).toBeGreaterThanOrEqual(0)
  expect(cursorRow).toBeLessThan(pane!.bodyLineBudget)
  expect(cursorRow).toBeLessThan(bodyRows.length)
})

test("GUI markdown body fills the pane without leaving a huge empty gap", () => {
  // Other suites' installStephenConfig leaks setFaceAttribute("default","height",140),
  // so reset to a known baseline first. markdown then remaps `default` to the
  // Emacs body height (`:height 200` = 20pt in my-markdown-mode-hook), which is
  // what sets the row cost here.
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
  editor.scratch("doc.md", lines.join("\n") + "\n", "markdown")

  const rows = 30
  const budget = pageScrollLines(rows)
  // 20pt body: `markdown-body-font-height` 200, in tenths of a point.
  const bodyPx = (getCustom<number>("markdown-body-font-height") ?? 200) / 10
  const bodyCost = (bodyPx * DOM_FRAME_LINE_HEIGHT_RATIO) / DOM_FRAME_ROW_PX
  const expectedLines = Math.floor(budget / bodyCost)

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows, cols: 80 },
    hostCapabilities: guiCaps,
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rendered = themedTextPlain(pane!.body).split("\n").length
  expect(rendered).toBeGreaterThanOrEqual(expectedLines - 1)
  expect(rendered).toBeLessThanOrEqual(expectedLines + 1)
  expect(rendered).toBeGreaterThan(budget / 2)
})

test("GUI caret does not change where a wrapped line breaks", () => {
  // Screenshot bug: putting point on a long soft-wrapped paragraph pushed the
  // last word onto its own row. `textWithCursor` inserts the block glyph into
  // the text before wrapping and `extractCursorMarker` pulls it back out after,
  // so on a GUI host -- which draws its own caret overlay -- that glyph still
  // consumed a column while the line was being broken. One extra character is
  // enough to wrap a word early, so the text reflowed as point moved.
  const editor = makeEditor()
  install(editor)
  const para = "A visible Electron window switches macOS Spaces, raises itself, "
    + "and steals keyboard focus from the user mid-session. It also cannot run "
    + "over ssh. builds the real DOM."
  const buffer = editor.scratch("doc.md", para + "\n", "markdown")

  const rowsFor = (point: number, cols: number): string[] => {
    buffer.point = point
    const model = buildDisplayModel(editor, {
      lastMessage: "",
      viewport: { rows: 30, cols },
      hostCapabilities: guiCaps,
    })
    const pane = model.windows.kind === "leaf" ? model.windows.pane : null
    return themedTextPlain(pane!.body).split("\n").map(r => r.trimEnd()).filter(r => r !== "")
  }

  // Every point in the paragraph has to wrap identically. The failures cluster
  // where point sits just before a wrap boundary (cols 50, point 49), so scan
  // rather than sampling one offset.
  for (const cols of [40, 50, 90]) {
    const base = rowsFor(0, cols)
    for (let point = 1; point < para.length; point++) {
      expect(rowsFor(point, cols)).toEqual(base)
    }
  }
})

test("the zero-width caret marker never reaches the rendered body", () => {
  // The marker is a layout-only placeholder. If a code path ever stops
  // extracting it -- e.g. the caret row falls outside the row budget -- it
  // would ship to the host inside the text, so assert it is always gone.
  const editor = makeEditor()
  install(editor)
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} with some words to wrap around the column`)
  const buffer = editor.scratch("doc.md", lines.join("\n") + "\n", "markdown")
  const charGridCaps = { ...guiCaps, perFaceFonts: false }
  for (const point of [0, 500, 2000, buffer.text.length - 1, buffer.text.length]) {
    buffer.point = point
    for (const hostCapabilities of [guiCaps, charGridCaps]) {
      const model = buildDisplayModel(editor, {
        lastMessage: "",
        viewport: { rows: 24, cols: 60 },
        hostCapabilities,
      })
      const pane = model.windows.kind === "leaf" ? model.windows.pane : null
      expect(themedTextPlain(pane!.body)).not.toContain("\u200b")
    }
  }
})
