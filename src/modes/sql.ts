import type { BufferModel } from "../kernel/buffer"
import { defineMode, type CompletionCandidate, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

// GNU `sql-mode` keeps one ANSI keyword list plus a per-product list, and it
// switches products with `sql-set-product`. A jemacs buffer records no product,
// so this is the union of the common dialects. Every lookup lowercases the
// word first, because SQL keywords are case-insensitive.
const sqlKeywords = new Set([
  "add", "after", "all", "alter", "analyze", "and", "any", "as", "asc", "begin", "between", "by", "cascade", "case", "cast", "check", "column", "commit", "concurrently", "conflict", "constraint", "create", "cross", "cube", "cursor", "database", "declare", "default", "deferrable", "delete", "desc", "distinct", "do", "drop", "each", "else", "end", "except", "exclude", "execute", "exists", "explain", "fetch", "filter", "first", "following", "for", "foreign", "from", "full", "function", "grant", "group", "grouping", "having", "if", "ilike", "immutable", "in", "index", "inner", "insert", "intersect", "into", "is", "join", "key", "language", "last", "lateral", "left", "like", "limit", "local", "loop", "materialized", "next", "no", "not", "nothing", "nowait", "nulls", "of", "offset", "on", "only", "or", "order", "outer", "over", "partition", "preceding", "primary", "procedure", "range", "recursive", "references", "regexp", "rename", "replace", "restrict", "return", "returning", "returns", "revoke", "right", "rollback", "rollup", "row", "rows", "schema", "select", "sequence", "set", "share", "similar", "some", "stable", "start", "table", "temp", "temporary", "then", "to", "transaction", "trigger", "truncate", "unbounded", "union", "unique", "unlogged", "update", "using", "vacuum", "values", "view", "volatile", "when", "where", "while", "window", "with", "without",
])
const sqlTypes = new Set([
  "array", "bigint", "bigserial", "binary", "bit", "blob", "bool", "boolean", "bytea", "char", "character", "clob", "date", "datetime", "decimal", "double", "enum", "float", "inet", "int", "int2", "int4", "int8", "integer", "interval", "json", "jsonb", "money", "nchar", "numeric", "nvarchar", "precision", "real", "serial", "smallint", "text", "time", "timestamp", "timestamptz", "tinyint", "uuid", "varchar", "varying", "xml",
])
const sqlConstants = new Set(["false", "null", "true", "unknown"])
const sqlFunctions = new Set([
  "abs", "array_agg", "avg", "coalesce", "concat", "count", "current_date", "current_time", "current_timestamp", "current_user", "dense_rank", "extract", "generate_series", "greatest", "json_agg", "lag", "lead", "least", "length", "lower", "max", "min", "now", "nullif", "rank", "round", "row_number", "string_agg", "substring", "sum", "to_char", "to_date", "to_timestamp", "trim", "upper",
])

const definitionStatement = /\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temp\s+|temporary\s+|unlogged\s+|materialized\s+|unique\s+|recursive\s+)*(?:table|view|index|function|procedure|trigger|type|schema|sequence|database)\s+(?:if\s+(?:not\s+)?exists\s+)?("[^"\n]+"|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/gi
const placeholder = /\$\d+|(?<!:):[A-Za-z_]\w*/g
const numberLiteral = /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g
const wordToken = /[A-Za-z_][\w$]*/g

export function installSqlMode(): void {
  defineMode({
    name: "sql-mode",
    parent: "prog-mode",
    commentStart: "--",
    indentLine: sqlIndentLine,
    fontLock: sqlFontLock,
    completeAtPoint: sqlCompleteAtPoint,
    imenuIndex: sqlImenuIndex,
  })
  defineMode({ name: "sql-ts-mode", parent: "sql-mode" })
}

/** Indent by open parenthesis depth, two columns per level. A line that starts
 *  with `)` closes the level it sits in, so it lines up with its opener. */
export function sqlIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^[ \t]*/, "")
  const depth = sqlParenDepthBefore(buffer.text, line.start)
  const closing = content.startsWith(")") ? 1 : 0
  const desired = Math.max(0, depth - closing) * 2
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function sqlFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...sqlProtectedSpans(text, offset))

  addDefinitionNames(text, offset, spans)
  addWordSpans(text, offset, spans)
  addMatches(text, numberLiteral, "number", spans, offset)
  addMatches(text, placeholder, "builtin", spans, offset)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** Index the objects a script defines: `CREATE TABLE users` gives `users`. */
export function sqlImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  const spans = sqlProtectedSpans(buffer.text, 0)
  for (const match of buffer.text.matchAll(definitionStatement)) {
    const name = match[1]!
    const start = (match.index ?? 0) + match[0].lastIndexOf(name)
    if (insideEnclosingSpan(spans, start)) continue
    entries.push({ name: name.replace(/"/g, ""), point: start })
  }
  return entries
}

export function sqlCompleteAtPoint(buffer: BufferModel): CompletionCandidate[] {
  const symbol = buffer.symbolBoundsAt()
  if (!symbol.text) return []
  const words = new Set([...sqlKeywords, ...sqlTypes, ...sqlConstants, ...sqlFunctions])
  for (const match of buffer.text.matchAll(wordToken)) words.add(match[0])
  return [...words]
    .filter(word => word.startsWith(symbol.text) && word !== symbol.text)
    .sort()
    .map(text => ({ text, start: symbol.start, end: symbol.end }))
}

/** Strings and comments, scanned first so no keyword pass can reach inside one.
 *  `''` inside a string is an escaped quote, `/ * * /` comments nest in
 *  PostgreSQL, and `"foo"` is a delimited identifier that `sql-mode-syntax-table`
 *  still gives string syntax, so all three land here. */
function sqlProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text.startsWith("--", i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (text.startsWith("/*", i)) {
      const end = blockCommentEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    const ch = text[i]!
    if (ch === "'" || ch === "\"" || ch === "`") {
      const end = quotedEnd(text, i, ch)
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    i++
  }
  return spans
}

function blockCommentEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length;) {
    if (text.startsWith("/*", i)) {
      depth++
      i += 2
      continue
    }
    if (text.startsWith("*/", i)) {
      depth--
      i += 2
      if (depth === 0) return i
      continue
    }
    i++
  }
  return text.length
}

function quotedEnd(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\" && quote !== "\"") {
      i++
      continue
    }
    if (text[i] !== quote) continue
    if (text[i + 1] === quote) {
      i++
      continue
    }
    return i + 1
  }
  return text.length
}

function addDefinitionNames(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(definitionStatement)) {
    const name = match[1]!
    const start = offset + (match.index ?? 0) + match[0].lastIndexOf(name)
    if (insideEnclosingSpan(spans, start)) continue
    spans.push({ start, end: start + name.length, face: "function" })
  }
}

function addWordSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(wordToken)) {
    const start = offset + (match.index ?? 0)
    if (insideSpan(spans, start)) continue
    const face = wordFace(match[0].toLowerCase())
    if (!face) continue
    spans.push({ start, end: start + match[0].length, face })
  }
}

function wordFace(word: string): TextSpan["face"] | null {
  if (sqlConstants.has(word)) return "constant"
  if (sqlTypes.has(word)) return "type"
  if (sqlFunctions.has(word)) return "builtin"
  if (sqlKeywords.has(word)) return "keyword"
  return null
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (insideSpan(spans, start)) continue
    spans.push({ start, end: start + match[0].length, face })
  }
}

function sqlParenDepthBefore(text: string, lineStart: number): number {
  const spans = sqlProtectedSpans(text.slice(0, lineStart), 0)
  let depth = 0
  for (let i = 0; i < lineStart; i++) {
    if (insideSpan(spans, i)) continue
    if (text[i] === "(") depth++
    else if (text[i] === ")") depth = Math.max(0, depth - 1)
  }
  return depth
}

function insideSpan(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end)
}

/** Like `insideSpan`, but a span that opens exactly at `point` does not count.
 *  A delimited identifier is its own string span, so `CREATE TABLE "t"` must
 *  still name `"t"`. */
function insideEnclosingSpan(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point > span.start && point < span.end)
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
