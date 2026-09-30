# jemacs-core — architecture map

Rules and conventions: `AGENTS.md` (this repo) and `../GEMINI.md` (workspace). This file only maps the code.

```
plugins/, lisp/        commands, modes, keybindings (hot-reloadable)
      ↓
src/kernel/            state: buffers, windows, keymaps, command registry. No commands.
      ↓
src/display/           Editor → LogicalModel → DisplayModel (pure, serializable)
      ↓
src/ui/, src/electron/ hosts: OpenTUI terminal, Electron GUI
```

## src/

| Dir | Contents |
|---|---|
| `kernel/` | `editor.ts` (dispatch: `handleKey` → `run`), `buffer.ts`, `window.ts`, `keymap.ts`, `command.ts`, `isearch.ts` |
| `runtime/` | `evaluator.ts` (`loadPlugin`), `plugin-context.ts`, `advice.ts`, `custom.ts`, `live-source.ts`, `definitions.ts` |
| `display/` | `build-display-model.ts`, `logical.ts`, `char-grid-layout.ts`, `protocol.ts`, `dom-frame.ts` |
| `ui/` | `select-host.ts` (`--gui`), `opentui-host.ts`, `electron-host.ts` |
| `electron/` | `bootstrap.mjs`, `preload.ts`, `renderer.ts`, `renderer.css` (global), `xterm-panes.ts` |
| `modes/` | `mode.ts` (`defineMode`), `minor-mode.ts`, `tree-sitter.ts`, `dired.ts`, `customize.ts` (largest file) |
| `lsp/` | Eglot-style client; per-server configs in `lsp/clients/` |
| `xref/` | definition / references / back-forward |
| `shadow/` | remote-edit sync (below) |
| `config/` | `default-bindings.ts`, startup. Slated to become plugins. |

Other top-level dirs: `lisp/` (TS port of `simple.el`, `files.el`, `window-cmds`, `minibuf`),
`plugins/` (loaded in order from `builtin.ts`), `packages/` (publishable barrels), `examples/`
(sample projects for LSP and dogfooding), `scripts/` (`build-electron.ts`, `tui-drive.sh`,
`emacs-drive.sh`, `reap-strays.sh`, `shadow-pair.sh`).

## Shadow sync (`src/shadow/`, design in `src/shadow/DESIGN.md`)

- Two editors: A (authority, for example a remote devbox with LSP) and S (shadow, the laptop).
- S applies edits locally at once and sends splices. On divergence A sends `rebase`: S rolls back,
  applies A's edits, then transforms and re-applies its own unacknowledged edits.
- A content-addressed store (`~/.jemacs/cas/`, SHA-256 chunks) keeps connect-time transfer small.
- For a buffer on a `ShadowLink`, S forwards LSP requests to A.
- Try it: `scripts/shadow-pair.sh`.
