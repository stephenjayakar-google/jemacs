/// <reference lib="dom" />
/**
 * Renderer half of pixel wrapping: measure the glyph advances of every font the
 * frame draws, and report the ones the kernel has not seen yet.
 *
 * The kernel wraps text-column buffers against these widths
 * (`FontMetricsTable`), so a width measured here is the width the row was
 * broken at. Measuring with a canvas context uses the same shaping engine as
 * the DOM, minus kerning between runs, which the row's slack absorbs.
 */

import type { SerializedDisplayModel, SerializedPane, SerializedWindowNode } from "./serialize"
import { PRELOAD_CHARS, domFontDefaults, fontKey, fontSpecFor } from "./font-metrics"

export type FontMetricsBatch = Record<string, Record<string, number>>

export class FontMeasurer {
  private readonly known = new Map<string, Set<string>>()
  private ctx: CanvasRenderingContext2D | null = null

  constructor(private readonly send: (batch: FontMetricsBatch, reset: boolean) => void) {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    fonts?.addEventListener?.("loadingdone", () => this.remeasureAll())
  }

  /** Measure whatever `model` draws that has not been measured, and send it. */
  observe(model: SerializedDisplayModel): void {
    const want = new Map<string, Set<string>>()
    const defaults = domFontDefaults(model.theme.faces.default, 1)
    const visit = (pane: SerializedPane) => {
      const paneDefaults = { ...defaults, textScale: pane.textScale ?? 1 }
      // The pane's default font always gets printable ASCII, so ordinary prose
      // wraps exactly on the first frame that needs it.
      addChars(want, fontKey(fontSpecFor({}, paneDefaults)), PRELOAD_CHARS)
      if (!pane.textColumn) return
      for (const chunk of pane.body.chunks) {
        const key = fontKey(fontSpecFor(chunk, paneDefaults))
        addChars(want, key, chunk.text)
        if (!this.known.has(key)) addChars(want, key, PRELOAD_CHARS)
      }
    }
    forEachPane(model.windows, visit)
    for (const frame of model.childFrames ?? []) visit(frame.pane)
    const batch = this.measure(want)
    if (batch) this.send(batch, false)
  }

  private remeasureAll(): void {
    const want = new Map<string, Set<string>>()
    for (const [key, chars] of this.known) want.set(key, new Set(chars))
    this.known.clear()
    const batch = this.measure(want)
    if (batch) this.send(batch, true)
  }

  private measure(want: Map<string, Set<string>>): FontMetricsBatch | null {
    const ctx = this.context()
    if (!ctx) return null
    const batch: FontMetricsBatch = {}
    let any = false
    for (const [key, chars] of want) {
      let known = this.known.get(key)
      if (!known) this.known.set(key, known = new Set())
      const fresh = [...chars].filter(ch => ch !== "\n" && !known!.has(ch))
      if (!fresh.length) continue
      ctx.font = key
      const widths: Record<string, number> = {}
      for (const ch of fresh) {
        widths[ch] = ctx.measureText(ch).width
        known.add(ch)
      }
      batch[key] = widths
      any = true
    }
    return any ? batch : null
  }

  private context(): CanvasRenderingContext2D | null {
    if (this.ctx) return this.ctx
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null
    const canvas = document.createElement("canvas")
    this.ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null
    return this.ctx
  }
}

function addChars(want: Map<string, Set<string>>, key: string, text: string): void {
  let set = want.get(key)
  if (!set) want.set(key, set = new Set())
  for (const ch of text) set.add(ch)
}

function forEachPane(node: SerializedWindowNode, fn: (pane: SerializedPane) => void): void {
  if (node.kind === "leaf") fn(node.pane)
  else {
    forEachPane(node.first, fn)
    forEachPane(node.second, fn)
  }
}
