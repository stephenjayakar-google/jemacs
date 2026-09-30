/**
 * `cursor-type` = box: the GUI/web caret becomes a block instead of a bar.
 *
 * Char-grid hosts always paint U+2588, so the custom only has to reach the hosts
 * that draw their own caret: the layout must ship `cursor.shape` and
 * `renderCaret` must widen the element and mark it `.block` (which is what the
 * stylesheet turns into a filled, non-blinking box).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig } from "../../src/config"
import { installDefaultModes } from "../../src/modes/default-modes"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { buildLogicalModel } from "../../src/display/logical"
import { webLayout } from "../../src/web/web-layout"
import { setCustom } from "../../src/runtime/custom"

const GUI = { unit: "pixels", mouse: true, clipboard: true, osc52: false, perFaceFonts: true } as const
const TUI = { unit: "cells", mouse: true, clipboard: true, osc52: false } as const

function guiPaneCursor(editor: Editor) {
  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 24, cols: 80 },
    hostCapabilities: { ...GUI },
  })
  return model.windows.kind === "leaf" ? model.windows.pane.cursor : undefined
}

beforeEach(() => {
  installDefaultModes()
})

afterEach(() => {
  setCustom("cursor-type", "bar")
})

test("cursor-type box marks the caret as a box for font-metric hosts", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("cursor-box", "hello world\n", "text")
  buffer.point = 3

  setCustom("cursor-type", "bar")
  expect(guiPaneCursor(editor)).toEqual({ row: 0, colOffset: 3 })

  setCustom("cursor-type", "box")
  expect(guiPaneCursor(editor)).toEqual({ row: 0, colOffset: 3, shape: "box" })
})

test("cursor-type box does not change the char-grid block glyph path", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("cursor-box-tui", "hello world\n", "text")
  buffer.point = 3
  setCustom("cursor-type", "box")

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 24, cols: 80 },
    hostCapabilities: { ...TUI },
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  // TUI hosts paint the glyph inline and get no `cursor` coordinate at all.
  expect(pane!.cursor).toBeUndefined()
  expect(pane!.body.chunks.map(c => c.text).join("")).toContain("\u2588")
})

test("webLayout carries the shape to the browser host", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("cursor-box-web", "hello world\n", "text")
  buffer.point = 3
  setCustom("cursor-type", "box")

  const model = webLayout(buildLogicalModel(editor), { rows: 24 })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane!.cursor?.shape).toBe("box")
})

test("renderCaret draws a wide .block element for a box cursor", async () => {
  const window = new Window({ url: "http://localhost" })
  const globals = globalThis as Record<string, unknown>
  // Other suites in the same bun process install their own DOM globals; capture
  // and restore them so this test cannot leak a happy-dom window into theirs.
  const saved = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    requestAnimationFrame: globals.requestAnimationFrame,
  }
  globals.window = window
  globals.document = window.document
  globals.HTMLElement = window.HTMLElement
  globals.requestAnimationFrame = undefined

  try {
    const { renderCaret, renderBodyRows } = await import("../../src/display/dom-frame")
    const el = window.document.createElement("div") as unknown as HTMLElement
    window.document.body.appendChild(el as never)

    const text = { chunks: [{ text: "hello world" }] }
    const bar = renderBodyRows(el, text as never)
    renderCaret(el, bar, { row: 0, colOffset: 3 })
    const barEl = el.querySelector(".jemacs-caret") as HTMLElement
    expect(barEl.className).not.toContain("block")
    const barWidth = Number.parseFloat(barEl.style.width)

    el.replaceChildren()
    const box = renderBodyRows(el, text as never)
    renderCaret(el, box, { row: 0, colOffset: 3, shape: "box" })
    const boxEl = el.querySelector(".jemacs-caret") as HTMLElement
    expect(boxEl.className).toContain("block")
    // happy-dom reports zero-width rects, so the box falls back to a fraction of
    // the font size -- still several times wider than the bar's 1/8.
    expect(Number.parseFloat(boxEl.style.width)).toBeGreaterThan(barWidth)
  } finally {
    Object.assign(globals, saved)
  }
})

test("a box cursor covers the line cell instead of overhanging it", async () => {
  // Screenshot bug: on a 2x markdown heading the block cursor hung below the
  // text. `fontPx * CARET_HEIGHT_RATIO` (1.2) is sized for a bar, which wants
  // to clear the glyph; Emacs sizes a box to the character cell -- measured
  // there, the box on a 40px heading is one line cell tall, not 48px of caret
  // floating over a 40px glyph.
  const window = new Window({ url: "http://localhost" })
  const globals = globalThis as Record<string, unknown>
  const saved = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    requestAnimationFrame: globals.requestAnimationFrame,
    getComputedStyle: globals.getComputedStyle,
  }
  globals.window = window
  globals.document = window.document
  globals.HTMLElement = window.HTMLElement
  globals.requestAnimationFrame = undefined
  // happy-dom does no layout, so stand in for the one metric the caret reads.
  // `dom-frame` calls bare `getComputedStyle`, which resolves against the
  // happy-dom window, so patch it there as well as on globalThis.
  const FONT_PX = 40
  const stubComputed = () => ({ fontSize: `${FONT_PX}px` })
  globals.getComputedStyle = stubComputed as never
  ;(window as unknown as Record<string, unknown>).getComputedStyle = stubComputed

  try {
    const mod = await import("../../src/display/dom-frame")
    const { renderCaret, renderBodyRows, DOM_FRAME_LINE_HEIGHT_RATIO, CARET_HEIGHT_RATIO } = mod
    const el = window.document.createElement("div") as unknown as HTMLElement
    window.document.body.appendChild(el as never)

    const heading = { chunks: [{ text: "AGENTS.md", height: FONT_PX * 10 }] }
    const rows = renderBodyRows(el, heading as never)
    renderCaret(el, rows, { row: 0, colOffset: 0, shape: "box" })
    const boxEl = el.querySelector(".jemacs-caret") as HTMLElement
    const boxHeight = Number.parseFloat(boxEl.style.height)

    // Exactly one line cell. A box is *taller* than a bar on purpose -- it
    // covers the cell, where the bar only clears the glyph -- so the bug was
    // never "too tall in the abstract", it was using the bar's ratio, which is
    // unrelated to the cell and left the box floating past the baseline.
    expect(boxHeight).toBe(Math.round(FONT_PX * DOM_FRAME_LINE_HEIGHT_RATIO))
    expect(boxHeight).not.toBe(Math.round(FONT_PX * CARET_HEIGHT_RATIO))

    // The bar keeps its own ratio: this fix must not change it.
    el.replaceChildren()
    const barRows = renderBodyRows(el, heading as never)
    renderCaret(el, barRows, { row: 0, colOffset: 0 })
    const barEl = el.querySelector(".jemacs-caret") as HTMLElement
    expect(Number.parseFloat(barEl.style.height)).toBe(Math.round(FONT_PX * CARET_HEIGHT_RATIO))
  } finally {
    Object.assign(globals, saved)
  }
})

test("a box cursor is exactly as wide as the glyph it covers", async () => {
  // Emacs ground truth, read with `font-get-glyphs` on the same buffer: the box
  // is the glyph's advance width -- 30px on the 40px heading `H`, and only 4px
  // on a narrow `i` at 20px. The previous assertion only checked "wider than a
  // bar", which a fixed 0.6-em guess also satisfies, so it could not catch a
  // box that ignored the glyph under point.
  const window = new Window({ url: "http://localhost" })
  const globals = globalThis as Record<string, unknown>
  const saved = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    requestAnimationFrame: globals.requestAnimationFrame,
  }
  globals.window = window
  globals.document = window.document
  globals.HTMLElement = window.HTMLElement
  globals.requestAnimationFrame = undefined

  // happy-dom does no text layout, so supply the per-character advance widths
  // Emacs measured. Range.getBoundingClientRect is what `charRectAtOffset` uses.
  const GLYPH_PX: Record<string, number> = { H: 30, i: 4 }
  const RangeProto = (window as unknown as { Range: { prototype: Record<string, unknown> } }).Range.prototype
  const savedRect = RangeProto.getBoundingClientRect
  RangeProto.getBoundingClientRect = function (this: Range) {
    const ch = this.toString()
    const width = GLYPH_PX[ch] ?? 0
    return { width, height: 0, left: 0, top: 0, right: width, bottom: 0, x: 0, y: 0 } as DOMRect
  }

  try {
    const { renderCaret, renderBodyRows } = await import("../../src/display/dom-frame")
    const el = window.document.createElement("div") as unknown as HTMLElement
    window.document.body.appendChild(el as never)

    const widthAt = (colOffset: number): number => {
      el.replaceChildren()
      const rows = renderBodyRows(el, { chunks: [{ text: "Hi", height: 400 }] } as never)
      renderCaret(el, rows, { row: 0, colOffset, shape: "box" })
      return Number.parseFloat((el.querySelector(".jemacs-caret") as HTMLElement).style.width)
    }

    expect(widthAt(0)).toBe(GLYPH_PX.H)
    // A narrow glyph must not inherit the wide one's box.
    expect(widthAt(1)).toBe(GLYPH_PX.i)
  } finally {
    RangeProto.getBoundingClientRect = savedRect
    Object.assign(globals, saved)
  }
})

test("a box cursor is anchored to the top of its line, a bar is not", async () => {
  // The reported bug was position, not size: a correctly-sized 54px box was
  // pinned to the glyph's top and hung 28px below a 54px row, painting over the
  // next line. Emacs anchors a box to the line -- `pos-visible-in-window-p` on
  // a 40px heading reports y=0 -- so `top` must be the row's own top, with no
  // centring term derived from the glyph rect.
  const window = new Window({ url: "http://localhost" })
  const globals = globalThis as Record<string, unknown>
  const saved = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    requestAnimationFrame: globals.requestAnimationFrame,
  }
  globals.window = window
  globals.document = window.document
  globals.HTMLElement = window.HTMLElement
  globals.requestAnimationFrame = undefined

  // Give the glyph a rect that is *not* the line box, which is what a real
  // Range reports and what misled the old centring math.
  const GLYPH_TOP = 3
  const GLYPH_HEIGHT = 19
  const RangeProto = (window as unknown as { Range: { prototype: Record<string, unknown> } }).Range.prototype
  const savedRect = RangeProto.getBoundingClientRect
  RangeProto.getBoundingClientRect = () =>
    ({ width: 30, height: GLYPH_HEIGHT, left: 0, top: GLYPH_TOP, right: 30, bottom: GLYPH_TOP + GLYPH_HEIGHT, x: 0, y: GLYPH_TOP }) as DOMRect

  try {
    const { renderCaret, renderBodyRows } = await import("../../src/display/dom-frame")
    const el = window.document.createElement("div") as unknown as HTMLElement
    window.document.body.appendChild(el as never)

    const render = (shape?: "box"): number => {
      el.replaceChildren()
      const rows = renderBodyRows(el, { chunks: [{ text: "Plan", height: 400 }] } as never)
      renderCaret(el, rows, { row: 0, colOffset: 0, ...(shape ? { shape } : {}) })
      return Number.parseFloat((el.querySelector(".jemacs-caret") as HTMLElement).style.top)
    }

    // Box: the line top, never the glyph top that caused the overhang.
    expect(render("box")).toBe(0)
    expect(render("box")).not.toBe(GLYPH_TOP)
    // Bar: unchanged, still positioned off the glyph it marks.
    expect(render()).toBeGreaterThan(0)
  } finally {
    RangeProto.getBoundingClientRect = savedRect
    Object.assign(globals, saved)
  }
})
