# jemacs-core — Claude context

@AGENTS.md

Architecture: `GEMINI.md`. Core/config split and hot reload: `DESIGN.md`. Plugin plan: `ROADMAP.md`.
`bun install` can hang behind a private npm registry that lacks `@opentui/*`; see `PROBLEMS.md`.

## Landing to upstream (`stephenjayakar/jemacs`)

1. Fetch `origin` and merge Stephen's direct pushes first.
2. Push to the fork and open a PR against `stephenjayakar/jemacs:main`.
3. Run `/code-review medium` on the PR diff (deep review for large batches).
4. If the review is clean and `bun test` passes: `gh pr merge <N> --repo stephenjayakar/jemacs --merge`.
   Do not enable auto-merge.
5. Pull `origin/main` into local `main` so the next batch starts from the merge commit.
