import {
  App,
  debounce,
  Editor,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian"
// Same parser jemacs' critique-mode uses, so both sides agree on the syntax.
import {
  formatCritiqueComment,
  parseCritiqueComments,
  type CritiqueComment,
  type CritiqueSyntax,
} from "../../plugins/critique/parse"

const VIEW_TYPE = "critique-comments"

type CritiqueSettings = { syntax: CritiqueSyntax }
const DEFAULT_SETTINGS: CritiqueSettings = { syntax: "obsidian" }

export default class CritiquePlugin extends Plugin {
  settings: CritiqueSettings = { ...DEFAULT_SETTINGS }
  /** Last focused markdown view; the sidebar keeps showing it while focused itself. */
  target: MarkdownView | null = null

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
    this.registerView(VIEW_TYPE, leaf => new CritiqueView(leaf, this))
    this.addRibbonIcon("message-square", "Open comments", () => void this.activateView())
    this.addSettingTab(new CritiqueSettingTab(this.app, this))

    this.addCommand({
      id: "open-comments",
      name: "Open comments panel",
      callback: () => void this.activateView(),
    })
    this.addCommand({
      id: "add-comment",
      name: "Comment on selection",
      editorCallback: (editor: Editor) => this.addComment(editor),
    })
    this.addCommand({
      id: "next-comment",
      name: "Go to next comment",
      editorCallback: (editor: Editor) => this.step(editor, 1),
    })
    this.addCommand({
      id: "previous-comment",
      name: "Go to previous comment",
      editorCallback: (editor: Editor) => this.step(editor, -1),
    })

    const refresh = debounce(() => this.refreshViews(), 150, true)
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf?.view instanceof MarkdownView) this.target = leaf.view
      refresh()
    }))
    this.registerEvent(this.app.workspace.on("editor-change", refresh))
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file === this.target?.file) refresh()
    }))
    this.app.workspace.onLayoutReady(() => {
      this.target = this.app.workspace.getActiveViewOfType(MarkdownView)
      this.refreshViews()
    })
  }

  async onunload(): Promise<void> {
    // Obsidian detaches the plugin's views itself.
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)
      await leaf?.setViewState({ type: VIEW_TYPE, active: true })
    }
    if (leaf) workspace.revealLeaf(leaf)
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof CritiqueView) leaf.view.render()
    }
  }

  /** Source text of the target view: the live editor buffer when available,
   *  otherwise the cached file contents (reading view). */
  async targetText(): Promise<{ view: MarkdownView; file: TFile; text: string } | null> {
    const view = this.target
    const file = view?.file
    if (!view || !file) return null
    const text = view.getMode() === "source" ? view.editor.getValue() : await this.app.vault.cachedRead(file)
    return { view, file, text }
  }

  addComment(editor: Editor): void {
    const quote = editor.getSelection()
    if (quote.includes("\n")) {
      new Notice("Critique comments must stay within one line")
      return
    }
    const from = editor.getCursor("from")
    const to = editor.getCursor("to")
    new CommentModal(this.app, quote ? "Comment on selection" : "Add comment", "", text => {
      editor.replaceRange(formatCritiqueComment(quote || null, text, this.settings.syntax), from, to)
    }).open()
  }

  step(editor: Editor, dir: 1 | -1): void {
    const comments = parseCritiqueComments(editor.getValue())
    const here = editor.posToOffset(editor.getCursor())
    const target = dir === 1
      ? comments.find(c => (c.highlightStart ?? c.start) > here)
      : [...comments].reverse().find(c => (c.highlightStart ?? c.start) < here)
    if (!target) {
      new Notice(dir === 1 ? "No next comment" : "No previous comment")
      return
    }
    selectComment(editor, target)
  }

  /** Focus the target note and put the selection on `c`'s highlighted text. */
  reveal(c: CritiqueComment): void {
    const view = this.target
    if (!view) return
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true })
    if (view.getMode() === "source") selectComment(view.editor, c)
    else view.setEphemeralState({ line: c.line })
  }

  /** Rewrite a comment in the target file: `edit` replaces its text, `resolve`
   *  drops it (keeping the highlighted text), `reply` adds another comment
   *  right after it, the same markup jemacs' `critique-reply-comment` writes. */
  async rewrite(c: CritiqueComment, change: { kind: "edit" | "reply"; text: string } | { kind: "resolve" }): Promise<void> {
    const t = await this.targetText()
    if (!t) return
    // Re-parse so stale offsets from an old render can't clobber an edit.
    const fresh = parseCritiqueComments(t.text).find(x => x.start === c.start && x.end === c.end)
    if (!fresh) {
      new Notice("Comment moved; try again")
      this.refreshViews()
      return
    }
    const replacement = change.kind === "resolve" ? fresh.quote
      : change.kind === "edit" ? formatCritiqueComment(fresh.quote || null, change.text, fresh.syntax)
      : t.text.slice(fresh.start, fresh.end) + formatCritiqueComment(null, change.text, fresh.syntax)
    if (t.view.getMode() === "source") {
      const editor = t.view.editor
      editor.replaceRange(replacement, editor.offsetToPos(fresh.start), editor.offsetToPos(fresh.end))
    } else {
      await this.app.vault.process(t.file, data =>
        data.slice(fresh.start, fresh.end) === t.text.slice(fresh.start, fresh.end)
          ? data.slice(0, fresh.start) + replacement + data.slice(fresh.end)
          : data)
    }
  }
}

function selectComment(editor: Editor, c: CritiqueComment): void {
  const from = editor.offsetToPos(c.highlightStart ?? c.start)
  const to = editor.offsetToPos(c.highlightEnd ?? c.end)
  editor.setSelection(from, to)
  editor.scrollIntoView({ from, to }, true)
}

class CritiqueView extends ItemView {
  private renderSeq = 0

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CritiquePlugin) {
    super(leaf)
  }

  getViewType(): string { return VIEW_TYPE }
  getDisplayText(): string { return "Comments" }
  getIcon(): string { return "message-square" }

  async onOpen(): Promise<void> {
    await this.render()
  }

  async render(): Promise<void> {
    const seq = ++this.renderSeq
    const t = await this.plugin.targetText()
    if (seq !== this.renderSeq) return
    const root = this.contentEl
    root.empty()
    root.addClass("critique-view")
    if (!t) {
      root.createDiv({ cls: "critique-empty", text: "Open a note to see its comments." })
      return
    }
    const comments = parseCritiqueComments(t.text)
    const header = root.createDiv({ cls: "critique-header" })
    header.createSpan({ cls: "critique-file", text: t.file.basename })
    header.createSpan({ cls: "critique-count", text: `${comments.length} comment${comments.length === 1 ? "" : "s"}` })
    if (!comments.length) {
      root.createDiv({ cls: "critique-empty", text: "No comments. Select text and run “Critique: Comment on selection”." })
      return
    }
    for (const c of comments) this.renderCard(root, c)
  }

  private renderCard(root: HTMLElement, c: CritiqueComment): void {
    const card = root.createDiv({ cls: "critique-card" })
    card.addEventListener("click", () => this.plugin.reveal(c))
    const meta = card.createDiv({ cls: "critique-meta" })
    meta.createSpan({ text: `Line ${c.line + 1}` })
    if (c.syntax === "critic") meta.createSpan({ cls: "critique-tag", text: "CriticMarkup" })
    if (c.quote) card.createDiv({ cls: "critique-quote", text: c.quote })
    card.createDiv({ cls: "critique-text", text: c.text || "(empty)" })
    const actions = card.createDiv({ cls: "critique-actions" })
    const edit = actions.createEl("button", { text: "Edit" })
    edit.addEventListener("click", evt => {
      evt.stopPropagation()
      new CommentModal(this.app, "Edit comment", c.text, text => void this.plugin.rewrite(c, { kind: "edit", text })).open()
    })
    const reply = actions.createEl("button", { text: "Reply" })
    reply.addEventListener("click", evt => {
      evt.stopPropagation()
      new CommentModal(this.app, "Reply", "", text => void this.plugin.rewrite(c, { kind: "reply", text })).open()
    })
    const resolve = actions.createEl("button", { text: "Resolve" })
    resolve.addEventListener("click", evt => {
      evt.stopPropagation()
      void this.plugin.rewrite(c, { kind: "resolve" })
    })
  }
}

class CommentModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly initial: string, private readonly onSubmit: (text: string) => void) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.heading)
    const input = this.contentEl.createEl("textarea", { cls: "critique-input" })
    input.value = this.initial
    input.rows = 3
    const submit = () => {
      const text = input.value.trim()
      if (!text) return
      this.close()
      this.onSubmit(text)
    }
    input.addEventListener("keydown", evt => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault()
        submit()
      }
    })
    new Setting(this.contentEl).addButton(b => b.setButtonText("Save").setCta().onClick(submit))
    window.setTimeout(() => input.focus(), 0)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

class CritiqueSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CritiquePlugin) {
    super(app, plugin)
  }

  display(): void {
    this.containerEl.empty()
    new Setting(this.containerEl)
      .setName("Comment syntax")
      .setDesc("Markup for new comments. Both are always read. Native works without any plugin: the highlight renders and the comment is hidden in reading view.")
      .addDropdown(d => d
        .addOption("obsidian", "Native: ==text==%%comment%%")
        .addOption("critic", "CriticMarkup: {==text==}{>>comment<<}")
        .setValue(this.plugin.settings.syntax)
        .onChange(async value => {
          this.plugin.settings.syntax = value === "critic" ? "critic" : "obsidian"
          await this.plugin.saveSettings()
        }))
  }
}
