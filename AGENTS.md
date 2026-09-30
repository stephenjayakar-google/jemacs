# jemacs-core — agent conventions

Workspace guide (repos, plugin API, hot-reload rules, gotchas): `../GEMINI.md`. This file adds
core-only rules. Architecture: `GEMINI.md`, `DESIGN.md`. Per-directory maps: `*/CLAUDE.md`.

## Workflow

- Make small changes that match the existing style.
- Run `bun run check` and `bun test` after code changes. If `bun` is not on `PATH`, use `npx bun`.
- Commit before you hand work back, unless the user says not to. One logical change per commit.
- New behavior goes in `plugins/<name>/index.ts` + `test/plugins/<name>.test.ts`, registered in
  `plugins/builtin.ts`. Do not add commands to `src/core/` or `src/config/`; they will become plugins.
- Edit `src/` only when a plugin needs an extension point the kernel lacks. Keep it minimal and say
  so in the commit message.

## Emacs fidelity

- Use the GNU command name, kebab-case (`beginning-of-buffer`). Invent a name only if Emacs has none.
- Match Emacs semantics. Check `lisp/` or the Emacs manual when unsure.
- Default bindings go in `src/config/default-bindings.ts` (see `DEFAULT_KEYBINDINGS.md`). Never
  hardcode keys in `handleKey()`.
- TS identifiers are camelCase (`beginningOfBuffer`). The command string stays kebab-case.

## Hosts

- `src/kernel/` and `src/display/` never import `@opentui/*` or Electron.
- Terminal: `src/ui/opentui-host.ts`. GUI: `src/ui/electron-host.ts` + `src/electron/renderer.ts`,
  which uses `src/display/dom-frame.ts`. Bootstrap: `runJemacs()` / `bindJemacsHost()` in `src/run.ts`.
- `packages/{jemacs-core,host-opentui,host-electron,host-web}` are re-export barrels. The app runs from the repo root.

## Self-modification (live eval)

- `src/runtime/definitions.ts` catalogs every definition with a source location (`captureCallerSource`).
- Commands: `eval-defun`, `load-file`, `reload-current-file`, `revert-definition`, `revert-all-definitions`.
- Eval context is `src/runtime/jemacs-runtime.ts`. Register through `editor.command`, `defcustom`,
  `registerKeyBinding`, etc. A bypass loses the source link.

## Verification

### GUI: headless only

```bash
bun run smoke:gui:headless
JEMACS_GUI_SCREENSHOT=/tmp/gui.png bun run smoke:gui:headless   # PNG, written even on failure
```

Headless still builds the real DOM, so it is not a weaker check. It shows no window, no dock icon,
and takes no focus. Use `ElectronHost.capturePage()` for screenshots, never `screencapture`.
Run `bun run smoke:gui` (visible) only for window-management bugs, and ask the user first.

### TUI: real terminal in tmux

Unit tests build `KeyEventLike` by hand, so they miss terminal key-encoding bugs (for example
`M->`, `C-_`). For key, minibuffer, or display changes, drive the real host:

```bash
export JEMACS_TMUX_SESSION=jt
scripts/tui-drive.sh start [file]     # uses test/fixtures/empty-config.ts; waits ≤12s for a frame
scripts/tui-drive.sh keys C-g C-x C-f "src/main.ts" Enter   # C-g first clears a stale echo area
scripts/tui-drive.sh cap              # or: capansi, modeline, wait 'regex' 5
scripts/tui-drive.sh stop
```

Full protocol: `.claude/skills/qa/SKILL.md`. Bug-fix loop: `.claude/skills/bugfix/SKILL.md`.

### Process hygiene: keep all four layers

Interrupted L3 tests once left 414 orphan `bun run src/main.ts` processes (7.3 GB). The bun process
is a grandchild of the tmux server, and it ignores `SIGHUP`/`SIGTERM` in raw mode. Four layers stop this:

1. `tui-drive.sh start` tags each spawn with `--jemacs-test-marker=<marker>:<run-id>` on the command line.
2. `tui-drive.sh stop` snapshots pane pids, then escalates `TERM` → `KILL` through `reap-strays.sh`.
3. `test/preload.ts` (via `bunfig.toml`) reaps stale runs at startup and this run's spawns on exit.
4. `tuiProbe()` reuses one session (`jt<pid>`) per runner.

Rules: never depend on `finally` alone. Never kill by matching `src/main.ts`; that also kills the
user's editor. Match the marker.

```bash
scripts/reap-strays.sh list | stale | kill
ps -eo pid,ppid,rss,etime,command | awk '$2==1 && /src\/main\.ts/'   # expect no output
```

### Emacs parity

Compare against Stephen's Emacs in tmux, not `emacs --batch` (markdown-mode hooks fail in batch).

```bash
scripts/emacs-drive.sh start examples/docs/guide.md   # same keys/cap/stop as tui-drive.sh
JEMACS_PARITY_EMACS=1 bun test test/tui/markdown-parity.test.ts
```

Harness: `test/harness/{tui,emacs,parity,screen}.ts`.
