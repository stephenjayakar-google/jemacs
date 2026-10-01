import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { makeEditor } from "../plugins/helper"
import { expandTexCommand, texCompileDefault } from "../../src/modes/tex-commands"

/** Text of the *messages* buffer, where `editor.message` echoes land. */
function messagesText(editor: ReturnType<typeof makeEditor>): string {
  return [...editor.buffers.values()].find(b => b.name === "*messages*")?.text ?? ""
}

function texEditor(text = "", name = "paper.tex"): ReturnType<typeof makeEditor> {
  const editor = makeEditor()
  const buffer = new BufferModel({ name, path: `/tmp/${name}`, text, mode: "latex-mode" })
  editor.addBuffer(buffer)
  editor.switchToBuffer(buffer.id)
  return editor
}

test("tex commands are registered under their GNU names", () => {
  const editor = makeEditor()
  for (const name of [
    "latex-insert-block", "latex-close-block", "latex-split-block", "latex-insert-item",
    "tex-goto-last-unclosed-latex-block", "tex-insert-quote", "tex-insert-braces",
    "tex-terminate-paragraph", "tex-validate-buffer", "tex-compile", "tex-file", "tex-view",
    "tex-bibtex-file",
  ]) {
    expect(editor.commands.get(name)).toBeDefined()
  }
})

test("latex-insert-block reads the block name and inserts the pair", async () => {
  const editor = texEditor()
  editor.completingRead = async () => "itemize"

  await editor.run("latex-insert-block")
  expect(editor.currentBuffer.text).toBe("\\begin{itemize}\n\\item \n\\end{itemize}\n")
})

test("latex-insert-block falls back to latex-block-default on empty input", async () => {
  const editor = texEditor()
  editor.completingRead = async () => ""

  await editor.run("latex-insert-block")
  expect(editor.currentBuffer.text).toBe("\\begin{enumerate}\n\\item \n\\end{enumerate}\n")
})

test("latex-close-block reports when nothing is open", async () => {
  const editor = texEditor("plain text\n")
  editor.currentBuffer.point = editor.currentBuffer.text.length

  await editor.run("latex-close-block")
  expect(editor.currentBuffer.text).toBe("plain text\n")
  expect(messagesText(editor)).toContain("No unclosed")
})

test("tex-insert-quote honours a prefix argument", async () => {
  const editor = texEditor("hi ")
  editor.currentBuffer.point = editor.currentBuffer.text.length

  await editor.run("tex-insert-quote")
  expect(editor.currentBuffer.text).toBe("hi ``")
})

test("tex-terminate-paragraph warns about an unbalanced paragraph", async () => {
  const editor = texEditor("open {brace")
  editor.currentBuffer.point = editor.currentBuffer.text.length

  await editor.run("tex-terminate-paragraph")
  expect(editor.currentBuffer.text).toBe("open {brace\n\n")
  expect(messagesText(editor)).toContain("mismatch")
})

test("tex-validate-buffer lists every unbalanced paragraph", async () => {
  const editor = texEditor("open {brace\n\nfine\n\nlone $x\n")

  await editor.run("tex-validate-buffer")
  const occur = [...editor.buffers.values()].find(b => b.name === "*Occur*")
  expect(occur?.text).toContain("paper.tex:1: Unclosed {")
  expect(occur?.text).toContain("paper.tex:5: Unmatched $")
})

test("tex-compile expands %f and %r against the visited file", () => {
  const buffer = new BufferModel({ name: "paper.tex", path: "/tmp/paper.tex", text: "", mode: "latex-mode" })

  expect(expandTexCommand("pdflatex %f", buffer)).toBe("pdflatex paper.tex")
  expect(expandTexCommand("bibtex %r", buffer)).toBe("bibtex paper")
  expect(texCompileDefault(buffer)).toBe("pdflatex paper.tex")
})
