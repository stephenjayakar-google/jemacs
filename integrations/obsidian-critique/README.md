# Critique for Obsidian

Sidebar viewer for margin comments written by jemacs' `critique-mode`. It reads the same syntax and uses the same parser (`plugins/critique/parse.ts`).

| syntax | example | without this plugin |
|---|---|---|
| native (default) | `==highlighted text==%%comment%%` | highlight renders, comment hidden in reading view |
| point comment | `%%comment%%` | hidden in reading view |
| CriticMarkup | `{==text==}{>>comment<<}`, `{>>comment<<}` | needs a CriticMarkup plugin to render |

Comments are single-line. Obsidian's multi-line `%%` block comments are left alone.

## Features

- **Comments panel** (ribbon icon or "Critique: Open comments panel"): lists the active note's comments with the quoted text. Click a card to jump to it. Each card has Edit and Resolve buttons; Resolve keeps the text and drops the comment.
- **Critique: Comment on selection**: wraps the selection, or adds a point comment at the cursor.
- **Critique: Go to next / previous comment**.
- A setting picks native or CriticMarkup syntax for new comments.

## Install

```bash
cd integrations/obsidian-critique
npm install
bun run build          # -> main.js
mkdir -p <vault>/.obsidian/plugins/critique
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/critique/
```

Then enable "Critique" under Settings → Community plugins.

## jemacs side

`M-x critique-mode` in a markdown buffer. It turns on by itself when you visit a file that already has comments.

| key | command |
|---|---|
| `C-c ;` | `critique-comment`: comment on region / edit comment at point / point comment |
| `C-c ]` / `C-c [` | next / previous comment |
| `C-c /` | `critique-resolve-comment` |
| `C-c C-x ;` | `critique-toggle-inline-comments`: show or hide the raw markup |
| | `critique-list-comments`: jump with completion |

Customize with `critique-syntax` (`"obsidian"` or `"critic"`), `critique-margin-width`, `critique-hide-inline-comments` and `critique-auto-enable`.
