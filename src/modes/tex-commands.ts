import { basename, dirname } from "node:path"
import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { defcustom, getCustom } from "../runtime/custom"
import { trackedContext, type PluginContext } from "../runtime/plugin-context"
import {
  latexCloseBlock,
  latexInsertBlock,
  latexInsertItem,
  latexSplitBlock,
  latexStandardBlockNames,
  texGotoLastUnclosedBlock,
  texInsertBraces,
  texInsertQuote,
  texTerminateParagraph,
  texUnbalancedParagraphs,
} from "./tex"

/** `tex-command`, the TeX program `tex-file` and friends run. */
defcustom("tex-command", "string", "pdflatex", "Command used to run TeX on a file.", "tex-run")
/** `tex-bibtex-command`, run by `tex-bibtex-file`. */
defcustom("tex-bibtex-command", "string", "bibtex", "Command used to run BibTeX on a file.", "tex-run")
/** `tex-run-command` view step; Emacs picks a DVI viewer, we open the PDF. */
defcustom("tex-view-command", "string", "open", "Command used by tex-view to display the output file.", "tex-run")
/** `latex-block-default`, the block `latex-insert-block` offers first. */
defcustom("latex-block-default", "string", "enumerate", "Default LaTeX block name offered by latex-insert-block.", "tex")

/** Blocks the user typed this session, kept alongside `latex-standard-block-names`. */
const sessionBlockNames = new Set<string>()

export function installTexCommands(editor: Editor, ctx?: PluginContext): void {
  // Route registration through a tracked context so a hot reload of this
  // module disposes the previous refs instead of stacking duplicates.
  ctx ??= trackedContext(editor, "modes/tex-commands")

  editor.command("latex-insert-block", async ({ editor, buffer, args }) => {
    const fallback = getCustom<string>("latex-block-default") || "enumerate"
    const name = args[0] ?? await editor.completingRead(`LaTeX block name [${fallback}]: `, {
      collection: blockNameCollection(),
      history: "latex-block-name",
    })
    const block = (name ?? "").trim() || fallback
    sessionBlockNames.add(block)
    latexInsertBlock(buffer, block)
  }, "Create a matching pair of lines \\begin{NAME} and \\end{NAME} at point.")

  editor.command("latex-close-block", ({ editor, buffer }) => {
    const name = latexCloseBlock(buffer)
    if (!name) editor.message("No unclosed \\begin")
  }, "Create an \\end{...} to match the last unclosed \\begin{...}.")

  editor.command("latex-split-block", ({ editor, buffer }) => {
    const name = latexSplitBlock(buffer)
    if (!name) editor.message("No unclosed \\begin")
  }, "Split the enclosing environment by inserting \\end{..}\\begin{..} at point.")

  editor.command("latex-insert-item", ({ buffer }) => {
    latexInsertItem(buffer)
  }, "Insert an \\item macro.")

  editor.command("tex-goto-last-unclosed-latex-block", ({ editor, buffer }) => {
    if (!texGotoLastUnclosedBlock(buffer)) editor.message("Couldn't find unended \\begin")
  }, "Move point to the last unclosed \\begin{...}.")

  editor.command("tex-insert-quote", ({ buffer, prefixArgument }) => {
    texInsertQuote(buffer, prefixArgument != null)
  }, "Insert the appropriate quote marks for TeX.")

  editor.command("tex-insert-braces", ({ buffer }) => {
    texInsertBraces(buffer)
  }, "Make a pair of braces and be poised to type inside of them.")

  editor.command("tex-terminate-paragraph", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument == null) {
      const problems = texUnbalancedParagraphs(buffer.text.slice(0, buffer.point))
      const last = problems.at(-1)
      if (last) editor.message(`Paragraph being closed appears to contain a mismatch: ${last.reason} (line ${last.line})`)
    }
    texTerminateParagraph(buffer)
  }, "Insert two newlines, breaking a paragraph for TeX.")

  editor.command("tex-validate-buffer", ({ editor, buffer }) => {
    const problems = texUnbalancedParagraphs(buffer.text)
    if (!problems.length) {
      editor.message("No mismatches found")
      return
    }
    const body = problems.map(p => `${buffer.name}:${p.line}: ${p.reason}`).join("\n")
    editor.scratch("*Occur*", `Mismatches:\n${body}\n`, "text")
  }, "Check the buffer for paragraphs containing mismatched braces or $s.")

  editor.command("tex-file", async ({ editor, buffer }) => {
    await runTexCommand(editor, buffer, getCustom<string>("tex-command") || "pdflatex")
  }, "Run TeX on the current buffer's file.")

  editor.command("tex-buffer", async ({ editor, buffer }) => {
    await runTexCommand(editor, buffer, getCustom<string>("tex-command") || "pdflatex")
  }, "Run TeX on the current buffer.")

  editor.command("tex-bibtex-file", async ({ editor, buffer }) => {
    const command = getCustom<string>("tex-bibtex-command") || "bibtex"
    await runTexCommand(editor, buffer, command, { stem: true })
  }, "Run BibTeX on the current buffer's file.")

  editor.command("tex-compile", async ({ editor, buffer, args }) => {
    const suggestion = texCompileDefault(buffer)
    const command = args[0] ?? await editor.prompt("Command: ", suggestion, "tex-compile")
    if (command == null) return
    await compile(editor, expandTexCommand(command, buffer), directoryOf(buffer))
  }, "Run a TeX command on the current buffer's file.")

  editor.command("tex-view", async ({ editor, buffer }) => {
    const viewer = getCustom<string>("tex-view-command") || "open"
    await compile(editor, `${viewer} ${shellQuote(`${stemOf(buffer)}.pdf`)}`, directoryOf(buffer))
  }, "Display the current buffer's TeX output file.")
}

/** `tex-compile-default`, reduced to the pdf-producing entry people pick. */
export function texCompileDefault(buffer: BufferModel): string {
  const command = getCustom<string>("tex-command") || "pdflatex"
  return `${command} ${shellQuote(fileNameOf(buffer))}`
}

/** `tex-compile`'s `%f` (file) and `%r` (file without suffix) substitutions. */
export function expandTexCommand(command: string, buffer: BufferModel): string {
  return command
    .replace(/%f/g, shellQuote(fileNameOf(buffer)))
    .replace(/%r/g, shellQuote(stemOf(buffer)))
}

async function runTexCommand(
  editor: Editor,
  buffer: BufferModel,
  command: string,
  options: { stem?: boolean } = {},
): Promise<void> {
  if (!buffer.path) {
    editor.message("Buffer is not visiting a file")
    return
  }
  if (buffer.dirty) await buffer.save()
  const target = options.stem ? stemOf(buffer) : fileNameOf(buffer)
  await compile(editor, `${command} ${shellQuote(target)}`, directoryOf(buffer))
}

/**
 * Route through `compile` so TeX errors land in `*compilation*` and
 * `next-error` walks them, which is what `tex-compile` does in Emacs.
 * The plugin loads after the modes, so resolve the command at call time.
 */
async function compile(editor: Editor, command: string, cwd: string): Promise<void> {
  if (!editor.commands.get("compile")) {
    editor.message(`Would run: ${command}`)
    return
  }
  const previous = editor.currentBuffer.locals.get("default-directory")
  editor.currentBuffer.locals.set("default-directory", cwd)
  try {
    await editor.run("compile", [command])
  } finally {
    if (previous == null) editor.currentBuffer.locals.delete("default-directory")
    else editor.currentBuffer.locals.set("default-directory", previous)
  }
}

function blockNameCollection(): string[] {
  return [...new Set([...latexStandardBlockNames, ...sessionBlockNames])].sort()
}

function fileNameOf(buffer: BufferModel): string {
  return buffer.path ? basename(buffer.path) : buffer.name
}

function stemOf(buffer: BufferModel): string {
  return fileNameOf(buffer).replace(/\.[^.]+$/, "")
}

function directoryOf(buffer: BufferModel): string {
  return buffer.path ? dirname(buffer.path) : buffer.directory() ?? process.cwd()
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}
