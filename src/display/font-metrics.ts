/**
 * Glyph advance widths measured by a pixel host, so the kernel can wrap text in
 * pixels instead of characters.
 *
 * Emacs redisplay knows each glyph's metrics, and `line-move-visual` walks the
 * screen lines that redisplay produced. Jemacs splits that work across two
 * processes: the renderer can measure, but the kernel decides where a line
 * breaks, because `C-n` must stay synchronous. So the renderer measures glyphs
 * once per font and sends the widths here; every wrap, row-cost and visual-line
 * computation then reads the same table, and the DOM never wraps a second time.
 *
 * A font key is also a valid CSS/canvas `font` shorthand, so the renderer can
 * measure exactly the string the kernel asks for.
 */

/** Font stacks for the Emacs `variable-pitch` / `fixed-pitch` base faces. They
 *  live here, not in `runtime/faces`, so the renderer bundle can compute font keys
 *  without pulling in the face registry. Bundled webfont first, then system
 *  stacks, then a generic family, so a missing file degrades to a different
 *  font of the same kind, never to serif. */
export const VARIABLE_PITCH_FAMILY = '"JemacsSans", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif'
export const FIXED_PITCH_FAMILY = '"JemacsMono", ui-monospace, "Fira Code", "Cascadia Code", Menlo, Consolas, monospace'

export type FontSpec = {
  family: string
  px: number
  weight: number
  italic: boolean
}

/** The chunk fields that decide which font a run is drawn in. */
export type FontStyleFields = {
  family?: string
  height?: number
  heightScale?: number
  bold?: boolean
  italic?: boolean
  weight?: string
}

/** Defaults a DOM pane applies when a chunk leaves a font field unset. */
export type FontDefaults = {
  family?: string
  px: number
  textScale: number
}

const WEIGHTS: Record<string, number> = {
  thin: 100, ultralight: 200, "ultra-light": 200, extralight: 200, "extra-light": 200,
  light: 300, semilight: 350, "semi-light": 350, normal: 400, regular: 400, book: 400,
  medium: 500, semibold: 600, "semi-bold": 600, demibold: 600, "demi-bold": 600,
  bold: 700, extrabold: 800, "extra-bold": 800, ultrabold: 800, "ultra-bold": 800,
  heavy: 900, black: 900, ultraheavy: 900, "ultra-heavy": 900,
}

/** CSS weight for an Emacs `:weight` symbol; `bold` alone means 700. */
export function cssFontWeight(style: { bold?: boolean; weight?: string }): number {
  const named = style.weight ? WEIGHTS[style.weight.toLowerCase()] : undefined
  if (named != null) return named
  return style.bold ? 700 : 400
}

/** Mirrors `DOM_FRAME_BODY_FONT_PX`: the body size when the theme sets none. */
const DOM_BODY_FONT_PX = 13

/** The font a DOM pane body applies to chunks that set no family or size. The
 *  renderer and the kernel both call this, so they agree on every font key. */
export function domFontDefaults(defaultFace: { family?: string; height?: number } | undefined, textScale: number): FontDefaults {
  return {
    family: defaultFace?.family,
    px: defaultFace?.height != null ? defaultFace.height / 10 : DOM_BODY_FONT_PX,
    textScale,
  }
}

/** Font size a DOM host paints `style` at. Mirrors `effectiveFontSizePx`. */
export function fontPxFor(style: FontStyleFields, defaults: FontDefaults): number {
  let px = style.height != null ? style.height / 10 : defaults.px
  if (style.heightScale != null) px *= style.heightScale
  if (defaults.textScale !== 1) px *= defaults.textScale
  return px
}

export function fontSpecFor(style: FontStyleFields, defaults: FontDefaults): FontSpec {
  return {
    family: style.family ?? defaults.family ?? FIXED_PITCH_FAMILY,
    px: fontPxFor(style, defaults),
    weight: cssFontWeight(style),
    italic: style.italic === true,
  }
}

/** Round to 1/100 px so float noise cannot mint a second key for one font. */
const roundPx = (px: number) => Math.round(px * 100) / 100

export function fontKey(spec: FontSpec): string {
  return `${spec.italic ? "italic " : ""}${spec.weight} ${roundPx(spec.px)}px ${spec.family}`
}

export function parseFontKey(key: string): FontSpec | null {
  const m = /^(italic )?(\d+) ([\d.]+)px (.+)$/.exec(key)
  if (!m) return null
  return { italic: !!m[1], weight: Number(m[2]), px: Number(m[3]), family: m[4]! }
}

/** Printable ASCII: measured up front for every font, so ordinary prose never
 *  has to wait a frame for its widths. */
export const PRELOAD_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("")

type FontEntry = { spec: FontSpec; widths: Map<string, number>; average: number }

/**
 * Advance widths per font. Filled by the host from renderer measurements.
 *
 * `version` changes on every merge, so a layout cache can tell whether its
 * widths are stale. The renderer measures every font and glyph it draws, so a
 * font the kernel has not seen yet is estimated for one frame and exact on the
 * next.
 */
export class FontMetricsTable {
  private readonly fonts = new Map<string, FontEntry>()
  version = 0

  get size(): number {
    return this.fonts.size
  }

  merge(batch: Record<string, Record<string, number>>, reset = false): void {
    if (reset) this.fonts.clear()
    for (const [key, widths] of Object.entries(batch)) {
      const spec = parseFontKey(key)
      if (!spec) continue
      let entry = this.fonts.get(key)
      if (!entry) {
        entry = { spec, widths: new Map(), average: 0 }
        this.fonts.set(key, entry)
      }
      for (const [ch, w] of Object.entries(widths)) {
        if (Number.isFinite(w) && w >= 0) entry.widths.set(ch, w)
      }
      entry.average = averageLowercase(entry.widths) ?? entry.average
    }
    this.version++
  }

  /** True when `ch` has a measured advance in the font `key`. */
  has(key: string, ch: string): boolean {
    return this.fonts.get(key)?.widths.has(ch) ?? false
  }

  /** Advance of `ch` in `spec`, in px. Unknown glyphs are estimated. */
  advance(ch: string, spec: FontSpec): number {
    const key = fontKey(spec)
    const entry = this.fonts.get(key)
    if (entry) {
      const w = entry.widths.get(ch)
      if (w != null) return w
      return estimateGlyph(ch, entry.average || spec.px * 0.55)
    }
    return estimateGlyph(ch, this.estimatedAverage(spec))
  }

  /**
   * Mean lowercase advance of `spec`: the `window-font-width` Emacs sizes a
   * fill column with, so `markdown-fill-column` columns are as wide as that many
   * average letters.
   */
  averageWidth(spec: FontSpec): number {
    const entry = this.fonts.get(fontKey(spec))
    if (entry?.average) return entry.average
    return this.estimatedAverage(spec)
  }

  /** Scale a measured sibling of the same family: advances grow linearly with size. */
  private estimatedAverage(spec: FontSpec): number {
    let best: FontEntry | undefined
    for (const entry of this.fonts.values()) {
      if (entry.spec.family !== spec.family || !entry.average) continue
      if (!best || scoreSibling(entry.spec, spec) < scoreSibling(best.spec, spec)) best = entry
    }
    if (best) return best.average * (spec.px / best.spec.px) * (spec.weight > best.spec.weight ? 1.05 : 1)
    return spec.px * 0.55
  }
}

function scoreSibling(a: FontSpec, b: FontSpec): number {
  return (a.weight === b.weight ? 0 : 2) + (a.italic === b.italic ? 0 : 1)
}

function averageLowercase(widths: Map<string, number>): number | null {
  let sum = 0
  let n = 0
  for (let c = 97; c <= 122; c++) {
    const w = widths.get(String.fromCharCode(c))
    if (w != null) { sum += w; n++ }
  }
  return n ? sum / n : null
}

/** East Asian wide and emoji glyphs are about two average letters wide. */
function estimateGlyph(ch: string, average: number): number {
  if (ch === "\u200b") return 0
  const cp = ch.codePointAt(0) ?? 0
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0x1f300 && cp <= 0x1faff))) return average * 2
  return average
}
