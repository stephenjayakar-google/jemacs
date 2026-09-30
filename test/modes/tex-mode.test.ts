import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import {
  bibtexFontLock,
  bibtexImenuIndex,
  installTexModes,
  latexCloseBlock,
  latexFontLock,
  latexImenuIndex,
  latexIndentLine,
  latexInsertBlock,
  latexInsertItem,
  latexSplitBlock,
  texFontLock,
  texGotoLastUnclosedBlock,
  texIndentLine,
  texInsertBraces,
  texInsertQuote,
  texUnbalancedParagraphs,
} from "../../src/modes/tex"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

/** Indent every line, the way `indent-region` drives `latex-indent`. */
function indentAll(text: string): string {
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })
  for (let line = 0; line < buffer.lineCount; line++) {
    buffer.point = buffer.lineBounds(line)[0]
    latexIndentLine(buffer)
  }
  return buffer.text
}

test("TeX-family modes register GNU mode names", () => {
  installTexModes()

  expect(getMode("tex-mode")?.parent).toBe("text")
  expect(getMode("tex-mode")?.commentStart).toBe("%")
  expect(getMode("latex-mode")?.parent).toBe("tex-mode")
  expect(getMode("latex-mode")?.commentStart).toBe("%")
  expect(getMode("plain-tex-mode")?.parent).toBe("tex-mode")
  expect(getMode("bibtex-mode")?.parent).toBe("text")
  expect(getMode("bibtex-mode")?.commentStart).toBe("%")
  expect(modeFeature("plain-tex-mode", "fontLock")).toBe(texFontLock)
  expect(modeFeature("latex-mode", "indentLine")).toBe(latexIndentLine)
  expect(modeFeature("bibtex-mode", "indentLine")).toBe(texIndentLine)
})

test("latex-mode-map carries the tex-mode.el bindings", () => {
  installTexModes()
  const keymap = getMode("latex-mode")!.keymap!

  expect(keymap.get("C-c C-o")).toBe("latex-insert-block")
  expect(keymap.get("C-c C-e")).toBe("latex-close-block")
  expect(keymap.get("C-c C-s")).toBe("latex-split-block")
  expect(keymap.get("C-c C-u")).toBe("tex-goto-last-unclosed-latex-block")
  expect(keymap.get("C-c ]")).toBe("latex-close-block")
  expect(keymap.get("M-RET")).toBe("latex-insert-item")
  expect(keymap.get("\"")).toBe("tex-insert-quote")
  expect(keymap.get("C-c {")).toBe("tex-insert-braces")
  expect(keymap.get("C-c C-c")).toBe("tex-compile")
})

// Faces captured from `emacs -Q --batch` with `font-lock-maximum-decoration t`:
// `\documentclass` argument is `font-lock-builtin-face`, a section title is
// `font-lock-function-name-face`, `\label`/`\ref`/`\cite` arguments are
// `font-lock-constant-face`, `\\` is `font-lock-warning-face`, and a `\url`
// argument plus a `verbatim` body are `tex-verbatim`.
test("latex-mode font-lock highlights TeX and LaTeX constructs", () => {
  installTexModes()
  const text = [
    "% top comment",
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "\\newcommand{\\vect}[1]{x}",
    "\\setcounter{secnumdepth}{3}",
    "\\begin{abstract}",
    "\\section{Introduction}",
    "Equation $x + y$ and $$z^2$$.",
    "\\label{sec:intro}",
    "See \\ref{sec:intro} and \\cite{knuth84}.",
    "Use \\url{http://example.com}.",
    "``quoted text''",
    "a & b \\\\",
    "\\end{abstract}",
  ].join("\n")
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })
  const spans = latexFontLock(buffer)

  expectSpan(text, spans, "% top comment", "comment")
  expectSpan(text, spans, "\\documentclass", "keyword")
  expectSpan(text, spans, "article", "builtin")
  expectSpan(text, spans, "\\usepackage", "keyword")
  expectSpan(text, spans, "amsmath", "builtin")
  expectSpan(text, spans, "\\vect", "function")
  expectSpan(text, spans, "secnumdepth", "variable")
  expectSpan(text, spans, "abstract", "function")
  expectSpan(text, spans, "\\section", "keyword")
  expectSpan(text, spans, "Introduction", "function")
  expectSpan(text, spans, "$x + y$", "string")
  expectSpan(text, spans, "$$z^2$$", "string")
  expectSpan(text, spans, "sec:intro", "constant")
  expectSpan(text, spans, "knuth84", "constant")
  expectSpan(text, spans, "http://example.com", "string")
  expectSpan(text, spans, "``", "keyword")
  expectSpan(text, spans, "quoted text", "string")
  expectSpan(text, spans, "&", "builtin")
  expectSpan(text, spans, "\\\\", "warning")

  const ranged = latexFontLock(buffer, { startLine: 5, endLine: 8, start: buffer.lineStarts[5]!, end: buffer.lineStarts[8]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "% top comment")).toBe(false)
  expectSpan(text, ranged, "abstract", "function")
  expectSpan(text, ranged, "Introduction", "function")
})

test("latex-mode font-lock leaves a verbatim body literal", () => {
  installTexModes()
  const text = "\\begin{verbatim}\nraw \\notacommand $x$\n\\end{verbatim}\n"
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })
  const spans = latexFontLock(buffer)

  const body = text.indexOf("\nraw")
  expect(spans).toContainEqual({ start: body, end: text.indexOf("\\end{verbatim}"), face: "string" })
  expect(spans.some(span => text.slice(span.start, span.end) === "\\notacommand")).toBe(false)
})

test("latex-mode font-lock adds weight to \\textbf and \\emph arguments", () => {
  installTexModes()
  const text = "\\emph{it} and \\textbf{bf}.\n"
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })
  const spans = latexFontLock(buffer)

  expect(spans).toContainEqual({ start: text.indexOf("it"), end: text.indexOf("it") + 2, face: "default", style: { italic: true } })
  expect(spans).toContainEqual({ start: text.indexOf("bf}"), end: text.indexOf("bf}") + 2, face: "default", style: { bold: true } })
})

// `latex-imenu-create-index` indents each entry one ". " per level below the
// shallowest sectioning command present, and lists \input files as "<<NAME.tex".
test("latex-mode imenu indexes sectioning commands and included files", () => {
  const text = [
    "\\section{Introduction}",
    "% \\section{Ignored}",
    "\\subsection{Details}",
    "\\subsubsection{Deep}",
    "\\input{other}",
  ].join("\n")
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })

  expect(latexImenuIndex(buffer)).toEqual([
    { name: "Introduction", point: text.indexOf("\\section") },
    { name: ". Details", point: text.indexOf("\\subsection") },
    { name: ". . Deep", point: text.indexOf("\\subsubsection") },
    { name: "<<other.tex", point: text.indexOf("\\input") },
  ])
})

test("latex-mode imenu keeps \\chapter as the top level when present", () => {
  const text = "\\chapter{Chap}\n\\section{One}\n"
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })

  expect(latexImenuIndex(buffer)).toEqual([
    { name: "Chap", point: 0 },
    { name: ". One", point: text.indexOf("\\section") },
  ])
})

// Every expectation below is the literal output of `indent-region` in
// `emacs -Q --batch` under `latex-mode`.
test("latex-mode indentation matches latex-indent", () => {
  expect(indentAll("\\begin{a}\n\\begin{b}\n\\begin{c}\nx\n\\end{c}\n\\end{b}\n\\end{a}\n"))
    .toBe("\\begin{a}\n  \\begin{b}\n    \\begin{c}\n      x\n    \\end{c}\n  \\end{b}\n\\end{a}\n")

  // `document` is in `latex-noindent-environments`, so its body stays flush left.
  expect(indentAll("\\begin{document}\nx\n\\end{document}\n"))
    .toBe("\\begin{document}\nx\n\\end{document}\n")

  // `tex-indent-item-re`: \item outdents by `tex-indent-item`, its body does not.
  expect(indentAll("\\begin{frame}\n\\begin{itemize}\n\\item a\ncont\n\\end{itemize}\n\\end{frame}\n"))
    .toBe("\\begin{frame}\n  \\begin{itemize}\n  \\item a\n    cont\n  \\end{itemize}\n\\end{frame}\n")

  expect(indentAll("\\newcommand{\\foo}{\nbar\n}\n")).toBe("\\newcommand{\\foo}{\n  bar\n}\n")

  // "Stick verbatim environments to the left margin" and leave the body alone.
  expect(indentAll("\\begin{a}\n\\begin{verbatim}\nx\n   y\n\\end{verbatim}\n\\end{a}\n"))
    .toBe("\\begin{a}\n\\begin{verbatim}\nx\n   y\n\\end{verbatim}\n\\end{a}\n")

  expect(indentAll("some text\nmore text\n")).toBe("some text\nmore text\n")
})

test("latex-insert-block writes a matching begin/end pair", () => {
  const buffer = new BufferModel({ name: "paper.tex", text: "", mode: "latex-mode" })

  latexInsertBlock(buffer, "itemize")
  expect(buffer.text).toBe("\\begin{itemize}\n\\item \n\\end{itemize}\n")
  expect(buffer.point).toBe(buffer.text.indexOf("\n\\end"))

  const center = new BufferModel({ name: "paper.tex", text: "", mode: "latex-mode" })
  latexInsertBlock(center, "center")
  expect(center.text).toBe("\\begin{center}\n  \n\\end{center}\n")
})

test("latex-close-block closes the innermost open environment", () => {
  const buffer = new BufferModel({ name: "paper.tex", text: "\\begin{itemize}\n\\item a\n", mode: "latex-mode" })
  buffer.point = buffer.text.length

  expect(latexCloseBlock(buffer)).toBe("itemize")
  expect(buffer.text).toBe("\\begin{itemize}\n\\item a\n\\end{itemize}\n")

  const empty = new BufferModel({ name: "paper.tex", text: "plain\n", mode: "latex-mode" })
  empty.point = empty.text.length
  expect(latexCloseBlock(empty)).toBeNull()
})

test("latex-split-block ends and reopens the enclosing environment", () => {
  const buffer = new BufferModel({ name: "paper.tex", text: "\\begin{itemize}\nfoo", mode: "latex-mode" })
  buffer.point = buffer.text.length

  expect(latexSplitBlock(buffer)).toBe("itemize")
  expect(buffer.text).toBe("\\begin{itemize}\nfoo\n\\end{itemize}\n\n\\begin{itemize}\n")
})

test("latex-insert-item adds an \\item at the block's indentation", () => {
  const buffer = new BufferModel({ name: "paper.tex", text: "\\begin{itemize}\n\\item a", mode: "latex-mode" })
  buffer.point = buffer.text.length

  latexInsertItem(buffer)
  expect(buffer.text).toBe("\\begin{itemize}\n\\item a\n\\item ")
  expect(buffer.point).toBe(buffer.text.length)
})

test("tex-goto-last-unclosed-latex-block moves point and sets the mark", () => {
  const text = "\\begin{a}\n\\begin{b}\n\\end{b}\nx"
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })
  buffer.point = text.length

  expect(texGotoLastUnclosedBlock(buffer)).toBe(true)
  expect(buffer.point).toBe(0)
  expect(buffer.mark).toBe(text.length)

  const closed = new BufferModel({ name: "paper.tex", text: "\\begin{a}\n\\end{a}\n", mode: "latex-mode" })
  closed.point = closed.text.length
  expect(texGotoLastUnclosedBlock(closed)).toBe(false)
})

// `tex-insert-quote` opens with `tex-open-quote` after whitespace and closes
// with `tex-close-quote` otherwise; a prefix argument forces a literal `"`.
test("tex-insert-quote picks the quote from context", () => {
  const cases: Array<[string, string, boolean]> = [
    ["hello ", "hello ``", false],
    ["hello ``world", "hello ``world''", false],
    ["word", "word''", false],
    ["hello ", "hello \"", true],
    ["% comment ", "% comment \"", false],
  ]
  for (const [before, after, literal] of cases) {
    const buffer = new BufferModel({ name: "paper.tex", text: before, mode: "latex-mode" })
    buffer.point = before.length
    texInsertQuote(buffer, literal)
    expect(buffer.text).toBe(after)
  }

  // A second `"` right after a fancy quote morphs it back to a plain one.
  const morph = new BufferModel({ name: "paper.tex", text: "hi ``", mode: "latex-mode" })
  morph.point = morph.text.length
  texInsertQuote(morph)
  expect(morph.text).toBe("hi \"")
})

test("tex-insert-braces leaves point between the braces", () => {
  const buffer = new BufferModel({ name: "paper.tex", text: "\\emph", mode: "latex-mode" })
  buffer.point = buffer.text.length

  texInsertBraces(buffer)
  expect(buffer.text).toBe("\\emph{}")
  expect(buffer.point).toBe(6)
})

test("tex-validate finds paragraphs with unbalanced braces or $", () => {
  expect(texUnbalancedParagraphs("balanced {x} $y$\n")).toEqual([])
  expect(texUnbalancedParagraphs("open {x\n\nfine\n")).toEqual([{ line: 1, reason: "Unclosed {" }])
  expect(texUnbalancedParagraphs("ok\n\nlone $x\n")).toEqual([{ line: 3, reason: "Unmatched $" }])
  // A `%` starts a comment, so a brace behind one does not count.
  expect(texUnbalancedParagraphs("text % {\n")).toEqual([])
})

test("bibtex-mode font-lock highlights entries, fields, values, and comments", () => {
  installTexModes()
  const text = [
    "% bibliography",
    "@article{knuth84,",
    "  author = {Donald E. Knuth},",
    "  title = \"Literate Programming\",",
    "  year = {1984},",
    "}",
    "@book{lamport94,",
    "  title = {LaTeX: A Document Preparation System},",
    "}",
  ].join("\n")
  const buffer = new BufferModel({ name: "refs.bib", text, mode: "bibtex-mode" })
  const spans = bibtexFontLock(buffer)

  expectSpan(text, spans, "% bibliography", "comment")
  expectSpan(text, spans, "@article", "keyword")
  expectSpan(text, spans, "knuth84", "constant")
  expectSpan(text, spans, "author", "type")
  expectSpan(text, spans, "{Donald E. Knuth}", "string")
  expectSpan(text, spans, "\"Literate Programming\"", "string")
  expectSpan(text, spans, "year", "type")
  expectSpan(text, spans, "{1984}", "string")
  expectSpan(text, spans, "@book", "keyword")
  expectSpan(text, spans, "lamport94", "constant")
})

test("bibtex-mode imenu indexes entry keys", () => {
  const text = [
    "% @article{ignored,",
    "@article{knuth84,",
    "  title = \"Literate Programming\",",
    "}",
    "@book{lamport94,",
    "  title = {LaTeX},",
    "}",
  ].join("\n")
  const buffer = new BufferModel({ name: "refs.bib", text, mode: "bibtex-mode" })

  expect(bibtexImenuIndex(buffer)).toEqual([
    { name: "knuth84", point: text.indexOf("knuth84") },
    { name: "lamport94", point: text.indexOf("lamport94") },
  ])
})
