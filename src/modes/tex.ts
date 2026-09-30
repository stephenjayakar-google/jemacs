import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

const texCommand = /\\(?:[A-Za-z@]+\*?|[^A-Za-z@\s\\])/g
const texSpecial = /\\\\\*?|&/g
const latexEnvironmentCommand = /\\(begin|end)\s*\{([^{}\n]+)\}/g
const bibtexEntryType = /@[A-Za-z]+/g
const bibtexEntry = /@[A-Za-z]+\s*[\({]\s*([^,\s]+)\s*,/g
const bibtexField = /(^|[,{\n])([ \t]*)([A-Za-z][A-Za-z0-9_-]*)\s*=/g

/** `latex-section-alist`: sectioning command → outline depth. */
const latexSectionAlist: Array<[string, number]> = [
  ["part", 0],
  ["chapter", 1],
  ["section", 2],
  ["subsection", 3],
  ["subsubsection", 4],
  ["paragraph", 5],
  ["subparagraph", 6],
]

/** `tex-font-lock-keywords-1`, group 3 → `font-lock-function-name-face`. */
const latexNameCommands = [
  "begin", "chapter", "end", "newcommand", "newenvironment", "newtheorem",
  "paragraph", "part", "providecommand", "renewcommand", "renewenvironment",
  "renewtheorem", "section", "subparagraph", "subsection", "subsubparagraph",
  "subsubsection", "title",
]

/** `tex-font-lock-keywords-1`, group 3 → `font-lock-builtin-face`. */
const latexFileCommands = [
  "bibliography", "documentclass", "documentstyle", "epsf", "epsfig",
  "include", "includegraphics\\*?", "includeonly", "input", "nofiles",
  "psfig", "usepackage", "verbatiminput",
]

/** `tex-font-lock-keywords-2`, group 3 → `font-lock-constant-face`. */
const latexReferenceCommands = [
  "bibitem", "cite[pt]?", "eqref", "glossary", "index", "label", "nocite",
  "(?:page|v)?ref",
]

/** `tex-font-lock-keywords-1`, group 2 → `font-lock-variable-name-face`. */
const latexCounterCommands = [
  "addtocounter", "addtolength", "newcounter\\*?", "setcounter", "setlength",
  "settowidth",
]

/** `tex-font-lock-keywords-1`, group 3 → `tex-verbatim`. */
const latexVerbatimArgCommands = ["ProvidesFile", "href", "nolinkurl", "path", "url"]

/** `tex-font-lock-keywords-2` warning commands: they break the page or the line. */
const latexWarningCommands = [
  "allowdisplaybreaks", "clearpage", "cleardoublepage", "displaybreak",
  "enlargethispage", "linebreak", "newline", "newpage", "nolinebreak",
  "nopagebreak", "pagebreak",
]

/** `tex-verbatim-environments`: their bodies are literal, so nothing inside is fontified. */
const texVerbatimEnvironments = ["verbatim", "verbatim*", "Verbatim"]

/** `latex-noindent-environments`: a `document` body stays at the left margin. */
const latexNoindentEnvironments = ["document"]

/** `tex-indent-item-re`: `\item` and `\bibitem` outdent by `tex-indent-item`. */
const texIndentItemRe = /^\\(?:bib)?item\b/

/** `latex-standard-block-names`, the completion table for `latex-insert-block`. */
export const latexStandardBlockNames = [
  "abstract", "array", "center", "description", "displaymath", "document",
  "enumerate", "eqnarray", "eqnarray*", "equation", "figure", "figure*",
  "flushleft", "flushright", "itemize", "letter", "list", "minipage",
  "picture", "quotation", "quote", "slide", "sloppypar", "tabbing", "table",
  "table*", "tabular", "tabular*", "thebibliography", "theindex*",
  "titlepage", "trivlist", "verbatim", "verbatim*", "verse", "math",
]

/** `latex-block-body-alist`: blocks whose skeleton opens with an `\item`. */
const latexItemBlocks = new Set(["enumerate", "itemize", "description", "list", "trivlist"])

const TEX_INDENT_BASIC = 2
const TEX_INDENT_ITEM = 2
const TEX_OPEN_QUOTE = "``"
const TEX_CLOSE_QUOTE = "''"

const namedGroup = (names: string[]): string => `(?:${names.join("|")})`
const argument = "[ \\t]*(?:\\[[^\\]\\n]*\\][ \\t]*)*\\{([^{}\\n]*)\\}"

const latexNameCommand = new RegExp(`\\\\${namedGroup(latexNameCommands)}\\*?${argument}`, "g")
const latexFileCommand = new RegExp(`\\\\${namedGroup(latexFileCommands)}${argument}`, "g")
const latexReferenceCommand = new RegExp(`\\\\${namedGroup(latexReferenceCommands)}${argument}`, "g")
const latexCounterCommand = new RegExp(`\\\\${namedGroup(latexCounterCommands)}${argument}`, "g")
const latexVerbatimArgCommand = new RegExp(`\\\\${namedGroup(latexVerbatimArgCommands)}${argument}`, "g")
const latexWarningCommand = new RegExp(`\\\\${namedGroup(latexWarningCommands)}(?![A-Za-z@])`, "g")
const latexDefCommand = /^[ \t]*\\def[ \t]*(\\[\w@]+)/gm
const latexNewCommandName = /\\(?:provide|(?:re)?new)command\** *(\\[A-Za-z@]+)/g
const latexSectionCommand = new RegExp(
  `\\\\(${latexSectionAlist.map(([name]) => name).join("|")})\\*?[ \\t]*(?:\\[[^\\]\\n]*\\][ \\t]*)*\\{([^{}\\n]*)\\}`,
  "g",
)
const latexIncludeCommand = /\\(include|input|verbatiminput|bibliography)[ \t]*\{([^}\n]+)\}/g
const texQuotePair = /(``|<<|«)((?:.|\n)+?)(''|>>|»)/g
/** `tex-font-lock-append-prop 'bold` / `'italic`: weight added over the argument. */
const latexBoldCommand = /\\(?:boldsymbol|pmb|text(?:bf|sc|up))[ \t]*\{((?:[^{}\\]|\\.)+)\}/g
const latexItalicCommand = /\\(?:emph|text(?:it|sl))[ \t]*\{((?:[^{}\\]|\\.)+)\}/g

export function installTexModes(): void {
  const texKeymap = new Keymap("tex-mode-map")
  bindTexKeys(texKeymap)

  const latexKeymap = new Keymap("latex-mode-map")
  bindTexKeys(latexKeymap)
  latexKeymap.bind("C-c C-e", "latex-close-block")
  latexKeymap.bind("C-c C-o", "latex-insert-block")
  latexKeymap.bind("C-c C-s", "latex-split-block")
  latexKeymap.bind("C-c C-t", "latex-insert-block")
  latexKeymap.bind("C-c C-u", "tex-goto-last-unclosed-latex-block")
  latexKeymap.bind("C-c /", "latex-close-block")
  latexKeymap.bind("C-c ]", "latex-close-block")
  latexKeymap.bind("M-RET", "latex-insert-item")

  defineMode({
    name: "tex-mode",
    parent: "text",
    commentStart: "%",
    keymap: texKeymap,
    indentLine: texIndentLine,
    fontLock: texFontLock,
  })
  defineMode({
    name: "latex-mode",
    parent: "tex-mode",
    commentStart: "%",
    keymap: latexKeymap,
    indentLine: latexIndentLine,
    fontLock: latexFontLock,
    imenuIndex: latexImenuIndex,
  })
  defineMode({ name: "plain-tex-mode", parent: "tex-mode", commentStart: "%" })
  defineMode({
    name: "bibtex-mode",
    parent: "text",
    commentStart: "%",
    indentLine: texIndentLine,
    fontLock: bibtexFontLock,
    imenuIndex: bibtexImenuIndex,
  })
}

/** `tex-mode-map`: the bindings both `tex-mode` and `latex-mode` share. */
function bindTexKeys(keymap: Keymap): void {
  keymap.bind("\"", "tex-insert-quote")
  keymap.bind("C-j", "tex-terminate-paragraph")
  keymap.bind("C-c {", "tex-insert-braces")
  keymap.bind("C-c }", "up-list")
  keymap.bind("C-c C-c", "tex-compile")
  keymap.bind("C-c C-f", "tex-file")
  keymap.bind("C-c C-r", "tex-region")
  keymap.bind("C-c C-b", "tex-buffer")
  keymap.bind("C-c tab", "tex-bibtex-file")
}

export function texIndentLine(_buffer: BufferModel): void {
  // TeX indentation is intentionally conservative here.
}

/**
 * `latex-indent`. Emacs computes the column from the enclosing sexp; we walk
 * the preceding lines and count unclosed environments and unclosed braces or
 * brackets, which agrees with `latex-find-indent` for the shapes people write.
 */
export function latexIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^[ \t]*/, "")
  const desired = latexDesiredIndent(buffer.text, line.start, content)
  if (desired == null) return

  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function texFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...texProtectedSpans(text, offset))

  addMatches(text, texCommand, "keyword", spans, offset)
  addTexSpecialSpans(text, offset, spans)
  addBraceSpans(text, offset, spans)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function latexFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  // Comments, math and verbatim bodies win over everything, exactly as
  // `font-lock-syntactic-face-function` runs before the keyword pass.
  spans.push(...texProtectedSpans(text, offset))

  // `tex-font-lock-keywords-1` and `-2`, in order. Each rule carries `keep` in
  // Emacs, so an earlier rule owns a span and later ones leave it alone. The
  // generic `\\[a-zA-Z@]+` catch-all is last for the same reason.
  addGroupedMatches(text, latexVerbatimArgCommand, "string", spans, offset, 1)
  addGroupedMatches(text, latexNameCommand, "function", spans, offset, 1)
  addGroupedMatches(text, latexNewCommandName, "function", spans, offset, 1)
  addGroupedMatches(text, latexDefCommand, "function", spans, offset, 1)
  addGroupedMatches(text, latexCounterCommand, "variable", spans, offset, 1)
  addGroupedMatches(text, latexFileCommand, "builtin", spans, offset, 1)
  addGroupedMatches(text, latexReferenceCommand, "constant", spans, offset, 1)
  addQuoteSpans(text, offset, spans)
  addMatches(text, latexWarningCommand, "warning", spans, offset)
  addMatches(text, texCommand, "keyword", spans, offset)

  addTexSpecialSpans(text, offset, spans)
  addBraceSpans(text, offset, spans)
  // `tex-font-lock-append-prop`: these carry weight on top of whatever face the
  // argument already has, so they are pushed last and never suppress a rule.
  addStyledArguments(text, latexBoldCommand, { bold: true }, spans, offset)
  addStyledArguments(text, latexItalicCommand, { italic: true }, spans, offset)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * `latex-imenu-create-index`. Emacs prefixes each entry with one
 * `latex-imenu-indent-string` (". ") per level below the shallowest sectioning
 * command in the buffer, and lists `\input`-style files as "<<NAME.tex".
 */
export function latexImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: Array<ImenuIndexEntry & { order: number }> = []
  const protectedSpans = texProtectedSpans(buffer.text, 0)
  const sections = [...buffer.text.matchAll(latexSectionCommand)]
    .filter(match => !insideStringOrComment(protectedSpans, match.index ?? 0))

  // "eb / search-forward-regexp \\part / \\chapter": the shallowest command
  // present sets level 0, so a chapter-less paper starts at \section.
  const depths = sections.map(match => sectionDepth(match[1] ?? ""))
  const base = depths.length ? Math.min(...depths) : 0

  for (const match of sections) {
    const point = match.index ?? 0
    const depth = sectionDepth(match[1] ?? "")
    const prefix = ". ".repeat(Math.max(0, depth - base))
    entries.push({ name: prefix + (match[2] ?? ""), point, order: point })
  }

  for (const match of buffer.text.matchAll(latexIncludeCommand)) {
    const point = match.index ?? 0
    if (insideStringOrComment(protectedSpans, point)) continue
    const file = match[2] ?? ""
    const suffix = match[1] === "bibliography" ? ".bbl" : ".tex"
    entries.push({ name: `<<${file}${suffix}`, point, order: point })
  }

  return entries.sort((a, b) => a.order - b.order).map(({ name, point }) => ({ name, point }))
}

export function bibtexFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...bibtexProtectedSpans(text, offset))

  addMatches(text, bibtexEntryType, "keyword", spans, offset)
  addGroupedMatches(text, bibtexEntry, "constant", spans, offset, 1)
  addGroupedMatches(text, bibtexField, "type", spans, offset, 3)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function bibtexImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  const protectedSpans = bibtexProtectedSpans(buffer.text, 0)
  for (const match of buffer.text.matchAll(bibtexEntry)) {
    const key = match[1]
    if (!key) continue
    const point = groupedStart(match, 1)
    if (insideStringOrComment(protectedSpans, point)) continue
    entries.push({ name: key, point })
  }
  return entries
}

// ── LaTeX editing commands ───────────────────────────────────────────────────

/** `latex-insert-block`: `\begin{NAME}` … `\end{NAME}` with point on the body. */
export function latexInsertBlock(buffer: BufferModel, name: string): void {
  // `latex-block-body-alist` gives \item blocks an opening `\item`; every other
  // block gets a plain body line. The skeleton's `>` then indents each line.
  const body = latexItemBlocks.has(name) ? "\\item " : ""
  insertSkeleton(buffer, [`\\begin{${name}}`, body, `\\end{${name}}`], 1)
}

/** `latex-close-block`: `\end{…}` for the last unclosed `\begin{…}`. */
export function latexCloseBlock(buffer: BufferModel): string | null {
  const open = lastUnclosedBlock(buffer.text, buffer.point)
  if (!open) return null
  insertSkeleton(buffer, [`\\end{${open.name}}`], "end")
  return open.name
}

/** `latex-split-block`: `\end{…}` then a fresh `\begin{…}` of the same block. */
export function latexSplitBlock(buffer: BufferModel): string | null {
  const open = lastUnclosedBlock(buffer.text, buffer.point)
  if (!open) return null
  insertSkeleton(buffer, [`\\end{${open.name}}`, "", `\\begin{${open.name}}`], 1)
  return open.name
}

/** `latex-insert-item`: a new `\item`, indented like the enclosing block. */
export function latexInsertItem(buffer: BufferModel): void {
  insertSkeleton(buffer, ["\\item "], "end", { trailingNewline: false })
}

/**
 * The part of `skeleton-insert` these commands use. Emacs' `\n` element opens a
 * fresh line and drops the trailing whitespace it left behind, `>` indents each
 * line with `latex-indent`, and `_` marks where point ends up.
 */
function insertSkeleton(
  buffer: BufferModel,
  lines: string[],
  cursorLine: number | "end",
  options: { trailingNewline?: boolean } = {},
): void {
  const line = buffer.lineBoundsAt()
  // An indent-only prefix belongs to the skeleton's own first line, so reuse it
  // rather than leaving a line of stray spaces above the block.
  if (buffer.text.slice(line.start, buffer.point).trim() === "") buffer.replaceRange(line.start, buffer.point, "")
  else buffer.insert("\n")

  const start = buffer.point
  const body = lines.join("\n") + (options.trailingNewline === false ? "" : "\n")
  buffer.replaceRange(start, start, body)

  const first = buffer.lineAt(start)
  for (let i = 0; i < lines.length; i++) {
    buffer.point = buffer.lineBounds(first + i)[0]
    latexIndentLine(buffer)
  }

  const target = cursorLine === "end" ? first + lines.length - 1 : first + cursorLine
  buffer.point = buffer.lineBounds(target)[1]
}

/** `tex-goto-last-unclosed-latex-block`: point to the `\begin`, mark where we were. */
export function texGotoLastUnclosedBlock(buffer: BufferModel): boolean {
  const open = lastUnclosedBlock(buffer.text, buffer.point)
  if (!open) return false
  buffer.setMark()
  buffer.point = open.start
  return true
}

/**
 * `tex-insert-quote`. Emacs inserts `tex-open-quote` after whitespace, an open
 * paren, `~` or `'`, and `tex-close-quote` otherwise. A literal `"` goes in
 * inside a comment or verbatim, after a backslash, or when the preceding text
 * already is a TeX quote (which is then removed).
 */
export function texInsertQuote(buffer: BufferModel, literal = false): void {
  const point = buffer.point
  const before = buffer.text.slice(0, point)

  if (literal || before.endsWith("\\") || insideCommentAt(buffer.text, point)) {
    buffer.insert("\"")
    return
  }

  // A second `"` right after a fancy quote morphs it back to a plain one.
  if (before.endsWith(TEX_OPEN_QUOTE) || before.endsWith(TEX_CLOSE_QUOTE)) {
    buffer.replaceRange(point - TEX_OPEN_QUOTE.length, point, "\"")
    return
  }

  const previous = before.slice(-1)
  const opening = previous === "" || /[\s([{<~']/.test(previous)
  buffer.insert(opening ? TEX_OPEN_QUOTE : TEX_CLOSE_QUOTE)
}

/** `tex-insert-braces`: `{}` with point between them. */
export function texInsertBraces(buffer: BufferModel): void {
  const point = buffer.point
  buffer.insert("{}")
  buffer.point = point + 1
}

/** `tex-terminate-paragraph`: two newlines, ending a TeX paragraph. */
export function texTerminateParagraph(buffer: BufferModel): void {
  buffer.insert("\n\n")
}

/**
 * `tex-validate-buffer`, reduced to the check callers need: report each
 * paragraph whose braces or `$` are unbalanced.
 */
export function texUnbalancedParagraphs(text: string): Array<{ line: number; reason: string }> {
  const problems: Array<{ line: number; reason: string }> = []
  let line = 1
  let paragraphLine = 1
  let braces = 0
  let dollars = 0
  let sawText = false

  const finish = () => {
    if (sawText) {
      if (braces !== 0) problems.push({ line: paragraphLine, reason: braces > 0 ? "Unclosed {" : "Unmatched }" })
      else if (dollars % 2 !== 0) problems.push({ line: paragraphLine, reason: "Unmatched $" })
    }
    braces = 0
    dollars = 0
    sawText = false
  }

  for (const raw of text.split("\n")) {
    const body = raw.slice(0, texCommentStart(raw))
    if (!body.trim()) {
      finish()
      paragraphLine = line + 1
    } else {
      if (!sawText) paragraphLine = line
      sawText = true
      for (let i = 0; i < body.length; i++) {
        if (isEscaped(body, i)) continue
        if (body[i] === "{") braces++
        else if (body[i] === "}") braces--
        else if (body[i] === "$") dollars++
      }
    }
    line++
  }
  finish()
  return problems
}

// ── Indentation ──────────────────────────────────────────────────────────────

function latexDesiredIndent(text: string, lineStart: number, content: string): number | null {
  // "Stick verbatim environments to the left margin", and leave their bodies
  // alone: a literal block means what it says.
  if (insideVerbatimEnvironment(text, lineStart)) return null
  if (isVerbatimDelimiter(content)) return 0

  const state = latexIndentStateBefore(text, lineStart)
  const closing = /^\\end\s*\{([^{}\n]+)\}/.exec(content)
  let depth = state.depth
  if (closing && !latexNoindentEnvironments.includes(closing[1] ?? "")) depth--

  // "Put leading close-paren where the matching open paren would be."
  let braces = state.braces
  if (/^[}\]]/.test(content)) braces--

  let indent = Math.max(0, depth) * TEX_INDENT_BASIC + Math.max(0, braces) * TEX_INDENT_BASIC
  // "Outdent \item if necessary."
  if (texIndentItemRe.test(content)) indent -= TEX_INDENT_ITEM

  if (indent === 0 && !closing && state.depth === 0 && state.braces === 0) return null
  return Math.max(0, indent)
}

type IndentState = { depth: number; braces: number }

/** Unclosed environments and unclosed braces or brackets before `lineStart`. */
function latexIndentStateBefore(text: string, lineStart: number): IndentState {
  let depth = 0
  let braces = 0

  for (const line of textLines(text.slice(0, lineStart))) {
    const body = line.text.slice(0, texCommentStart(line.text))
    if (!body.trim()) continue

    for (const match of body.matchAll(latexEnvironmentCommand)) {
      const name = match[2] ?? ""
      // `document` is in `latex-noindent-environments`, so its body is flush left.
      if (latexNoindentEnvironments.includes(name)) continue
      if (match[1] === "begin") depth++
      else depth = Math.max(0, depth - 1)
    }

    for (let i = 0; i < body.length; i++) {
      if (isEscaped(body, i)) continue
      const ch = body[i]
      if (ch === "{" || ch === "[") braces++
      else if (ch === "}" || ch === "]") braces = Math.max(0, braces - 1)
    }

  }

  return { depth, braces }
}

function isVerbatimDelimiter(content: string): boolean {
  const match = /^\\(?:begin|end)\s*\{([^{}\n]+)\}/.exec(content)
  return !!match && texVerbatimEnvironments.includes(match[1] ?? "")
}

function insideVerbatimEnvironment(text: string, point: number): boolean {
  let inside = false
  for (const line of textLines(text.slice(0, point))) {
    const body = line.text.slice(0, texCommentStart(line.text))
    for (const match of body.matchAll(latexEnvironmentCommand)) {
      if (!texVerbatimEnvironments.includes(match[2] ?? "")) continue
      inside = match[1] === "begin"
    }
  }
  return inside
}

// ── Block helpers shared by the editing commands ─────────────────────────────

type OpenBlock = { name: string; start: number; column: number }

/** The innermost `\begin{…}` with no matching `\end{…}` before `point`. */
function lastUnclosedBlock(text: string, point: number): OpenBlock | null {
  const before = text.slice(0, point)
  const stack: OpenBlock[] = []
  for (const line of textLines(before)) {
    const body = line.text.slice(0, texCommentStart(line.text))
    for (const match of body.matchAll(latexEnvironmentCommand)) {
      const at = line.start + (match.index ?? 0)
      if (match[1] === "begin") {
        stack.push({ name: match[2] ?? "", start: at, column: at - line.start })
      } else {
        stack.pop()
      }
    }
  }
  return stack.at(-1) ?? null
}

/**
 * Where a skeleton starts and how far it indents. Emacs' `\n` skeleton element
 * opens a fresh line, so trailing whitespace on the current line is absorbed;
 * the block then lines up with that line's own indentation, or with the
 * enclosing `\begin` when one is given.
 */
function openBlockPosition(buffer: BufferModel, _skeleton: string, column?: number): { start: number; indent: number } {
  const line = buffer.lineBoundsAt()
  const content = buffer.text.slice(line.start, buffer.point)
  if (content.trim() === "") {
    const indent = column ?? content.length
    return { start: line.start, indent }
  }
  const lineIndent = line.text.length - line.text.replace(/^[ \t]*/, "").length
  return { start: buffer.point, indent: column ?? lineIndent }
}

function atLineStart(buffer: BufferModel): boolean {
  return buffer.point === 0 || buffer.text[buffer.point - 1] === "\n"
}

function insideCommentAt(text: string, point: number): boolean {
  const lineStart = point <= 0 ? 0 : text.lastIndexOf("\n", point - 1) + 1
  const line = text.slice(lineStart, point)
  return texCommentStart(line) < line.length
}

function sectionDepth(name: string): number {
  return latexSectionAlist.find(([section]) => section === name)?.[1] ?? 0
}

// ── Font-lock helpers ────────────────────────────────────────────────────────

function texProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text[i] === "%" && !isEscaped(text, i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    const verbatim = verbatimBodyAt(text, i)
    if (verbatim != null) {
      spans.push({ start: offset + i, end: offset + verbatim, face: "string" })
      i = verbatim
      continue
    }
    if (text.startsWith("$$", i) && !isEscaped(text, i)) {
      const end = findDelimitedEnd(text, i + 2, "$$")
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    if (text[i] === "$" && !isEscaped(text, i)) {
      const end = findDelimitedEnd(text, i + 1, "$")
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    i++
  }
  return spans
}

/**
 * When `i` sits just past `\begin{verbatim}`, the offset just before the
 * matching `\end`. Emacs marks that body `tex-verbatim` and stops fontifying it.
 */
function verbatimBodyAt(text: string, i: number): number | null {
  if (text[i] !== "\n") return null
  const lineStart = i <= 0 ? 0 : text.lastIndexOf("\n", i - 1) + 1
  const opener = /\\begin\s*\{([^{}\n]+)\}/.exec(text.slice(lineStart, i))
  if (!opener || !texVerbatimEnvironments.includes(opener[1] ?? "")) return null
  const closer = text.indexOf(`\\end{${opener[1]}}`, i)
  return closer === -1 ? text.length : closer
}

function bibtexProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text[i] === "%" && !isEscaped(text, i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (text[i] === "=") {
      const valueStart = firstNonWhitespace(text, i + 1)
      if (valueStart !== -1 && text[valueStart] === "\"") {
        const end = findQuotedEnd(text, valueStart)
        spans.push({ start: offset + valueStart, end: offset + end, face: "string" })
        i = end
        continue
      }
      if (valueStart !== -1 && text[valueStart] === "{") {
        const end = findBracedEnd(text, valueStart)
        spans.push({ start: offset + valueStart, end: offset + end, face: "string" })
        i = end
        continue
      }
    }
    i++
  }
  return spans
}

function addTexSpecialSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(texSpecial)) {
    const localStart = match.index ?? 0
    if (match[0] === "&" && isEscaped(text, localStart)) continue
    const start = offset + localStart
    // `\\` is `font-lock-warning-face` in Emacs: it forces a line break.
    const face = match[0].startsWith("\\") ? "warning" : "builtin"
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + match[0].length, face })
  }
}

function addBraceSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== "{" && ch !== "}") continue
    const start = offset + i
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + 1, face: "type" })
  }
}

/** ``…'' quotes: the marks take `keyword`, the quoted text takes `string`. */
function addQuoteSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(texQuotePair)) {
    const start = offset + (match.index ?? 0)
    if (insideStringOrComment(spans, start)) continue
    const open = match[1] ?? ""
    const body = match[2] ?? ""
    const close = match[3] ?? ""
    spans.push({ start, end: start + open.length, face: "keyword" })
    spans.push({ start: start + open.length, end: start + open.length + body.length, face: "string" })
    spans.push({ start: start + open.length + body.length, end: start + match[0].length, face: "keyword" })
  }
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (!claimed(spans, start)) spans.push({ start, end: start + match[0].length, face })
  }
}

function addGroupedMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, group: number): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group]
    if (!word) continue
    const start = offset + groupedStart(match, group)
    if (!claimed(spans, start)) spans.push({ start, end: start + word.length, face })
  }
}

/**
 * `tex-font-lock-append-prop`: `\textbf{x}` makes `x` bold without replacing
 * the face it already carries, so this pushes a style-only span.
 */
function addStyledArguments(text: string, regex: RegExp, style: TextSpan["style"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const word = match[1]
    if (!word) continue
    const start = offset + groupedStart(match, 1)
    if (insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + word.length, face: "default", style })
  }
}

function groupedStart(match: RegExpMatchArray, group: number): number {
  const word = match[group] ?? match[0]
  return (match.index ?? 0) + match[0].lastIndexOf(word)
}

function findDelimitedEnd(text: string, start: number, delimiter: "$" | "$$"): number {
  for (let i = start; i < text.length;) {
    const next = text.indexOf(delimiter, i)
    if (next === -1) return text.length
    if (!isEscaped(text, next)) return next + delimiter.length
    i = next + delimiter.length
  }
  return text.length
}

function findQuotedEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === "\\") i += 2
    else if (text[i] === "\"") return i + 1
    else i++
  }
  return text.length
}

function findBracedEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{" && !isEscaped(text, i)) depth++
    else if (ch === "}" && !isEscaped(text, i)) {
      depth--
      if (depth <= 0) return i + 1
    }
  }
  return text.length
}

function texCommentStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && !isEscaped(text, i)) return i
  }
  return text.length
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++
  return backslashes % 2 === 1
}

function firstNonWhitespace(text: string, start: number): number {
  for (let i = start; i < text.length; i++) if (!/\s/.test(text[i]!)) return i
  return -1
}

function insideStringOrComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && (span.face === "string" || span.face === "comment"))
}

/** Emacs' `keep`: a later font-lock rule leaves an already fontified span alone. */
function claimed(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && span.face !== "default")
}

function textLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const end = lineEnd(text, start)
    lines.push({ text: text.slice(start, end), start, end })
    if (end === text.length) break
    start = end + 1
  }
  return lines
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}

function fontLockSlice(buffer: BufferModel, range?: FontLockRange): { text: string; offset: number } {
  if (!range) return { text: buffer.text, offset: 0 }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { text: buffer.text.slice(start, end), offset: start }
}
