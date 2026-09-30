import { expect, test } from "bun:test"
import { BufferModel, inferMode } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installSqlMode, sqlCompleteAtPoint, sqlFontLock, sqlImenuIndex } from "../../src/modes/sql"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"], from = 0): void {
  const start = text.indexOf(needle, from)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

function faceAt(text: string, spans: TextSpan[], needle: string, from = 0): TextSpan["face"] | undefined {
  const start = text.indexOf(needle, from)
  expect(start).toBeGreaterThanOrEqual(0)
  return spans.find(span => span.start === start)?.face
}

test("sql-mode installs a prog-mode child with SQL comments", () => {
  installSqlMode()

  expect(getMode("sql-mode")?.parent).toBe("prog-mode")
  expect(getMode("sql-mode")?.commentStart).toBe("--")
  expect(getMode("sql-ts-mode")?.parent).toBe("sql-mode")
  expect(modeFeature("sql-mode", "fontLock")).toBeDefined()
  expect(modeFeature("sql-mode", "indentLine")).toBeDefined()
  expect(modeFeature("sql-mode", "imenuIndex")).toBeDefined()
  expect(modeFeature("sql-mode", "completeAtPoint")).toBeDefined()
})

test("inferMode routes sql files", () => {
  expect(inferMode("db/schema.sql")).toBe("sql-mode")
  expect(inferMode("MIGRATION.SQL")).toBe("sql-mode")
})

test("sql-mode font-lock highlights comments, keywords, types, functions, and literals", () => {
  installSqlMode()
  const text = [
    "-- seed data",
    "/* block /* nested */ comment */",
    "CREATE TABLE users (",
    "  id integer PRIMARY KEY,",
    "  name varchar(64) NOT NULL DEFAULT 'it''s fine'",
    ");",
    "SELECT count(id) FROM users WHERE name = 'select' AND id > 10 AND active = true;",
    "SELECT * FROM users WHERE id = $1 OR id = :other;",
  ].join("\n")
  const buffer = new BufferModel({ name: "schema.sql", text, mode: "sql-mode" })
  const spans = sqlFontLock(buffer)

  expectSpan(text, spans, "-- seed data", "comment")
  expectSpan(text, spans, "/* block /* nested */ comment */", "comment")
  expectSpan(text, spans, "CREATE", "keyword")
  expectSpan(text, spans, "TABLE", "keyword")
  expectSpan(text, spans, "users", "function")
  expectSpan(text, spans, "integer", "type")
  expectSpan(text, spans, "varchar", "type")
  expectSpan(text, spans, "count", "builtin")
  expectSpan(text, spans, "true", "constant")
  expectSpan(text, spans, "'it''s fine'", "string")
  expectSpan(text, spans, "10", "number")
  expectSpan(text, spans, "$1", "builtin")
  expectSpan(text, spans, ":other", "builtin")
})

test("sql-mode font-lock leaves keywords inside strings and comments alone", () => {
  installSqlMode()
  const text = "SELECT 'SELECT from table' AS label; -- SELECT again\n"
  const buffer = new BufferModel({ name: "q.sql", text, mode: "sql-mode" })
  const spans = sqlFontLock(buffer)

  expect(faceAt(text, spans, "'SELECT from table'")).toBe("string")
  expect(faceAt(text, spans, "SELECT", text.indexOf("'"))).toBe(undefined)
  expect(faceAt(text, spans, "-- SELECT again")).toBe("comment")
})

test("sql-mode font-lock honours a line range", () => {
  installSqlMode()
  const text = "-- header\nSELECT 1;\nDELETE FROM users;\n"
  const buffer = new BufferModel({ name: "q.sql", text, mode: "sql-mode" })
  const ranged = sqlFontLock(buffer, { startLine: 1, endLine: 2, start: buffer.lineStarts[1]!, end: buffer.lineStarts[2]! })

  expect(ranged.some(span => text.slice(span.start, span.end) === "-- header")).toBe(false)
  expectSpan(text, ranged, "SELECT", "keyword")
  expect(ranged.some(span => text.slice(span.start, span.end) === "DELETE")).toBe(false)
})

test("sql-mode imenu indexes created objects", () => {
  const text = [
    "CREATE TABLE IF NOT EXISTS public.users (id int);",
    "CREATE UNIQUE INDEX users_name_idx ON users (name);",
    "CREATE OR REPLACE VIEW active_users AS SELECT * FROM users;",
    "CREATE TABLE \"quoted name\" (id int);",
    "-- CREATE TABLE ignored (id int);",
    "/* CREATE TABLE also_ignored (id int); */",
  ].join("\n")
  const buffer = new BufferModel({ name: "schema.sql", text, mode: "sql-mode" })

  expect(sqlImenuIndex(buffer)).toEqual([
    { name: "public.users", point: text.indexOf("public.users") },
    { name: "users_name_idx", point: text.indexOf("users_name_idx") },
    { name: "active_users", point: text.indexOf("active_users") },
    { name: "quoted name", point: text.indexOf("\"quoted name\"") },
  ])
})

test("sql-mode indents by parenthesis depth", () => {
  installSqlMode()
  const buffer = new BufferModel({ name: "schema.sql", text: "CREATE TABLE t (\nid int,\n      name text\n)\n", mode: "sql-mode" })
  const indentLine = modeFeature("sql-mode", "indentLine")!

  buffer.point = buffer.text.indexOf("id int")
  indentLine(buffer)
  expect(buffer.text).toContain("CREATE TABLE t (\n  id int,\n")

  buffer.point = buffer.text.indexOf("name text")
  indentLine(buffer)
  expect(buffer.text).toContain("  id int,\n  name text\n")

  buffer.point = buffer.text.indexOf(")\n")
  indentLine(buffer)
  expect(buffer.text).toContain("  name text\n)\n")
})

test("sql-mode completion offers keywords and buffer words", () => {
  const buffer = new BufferModel({ name: "q.sql", text: "SELECT sel", mode: "sql-mode" })
  buffer.point = buffer.text.length

  const candidates = sqlCompleteAtPoint(buffer).map(candidate => candidate.text)
  expect(candidates).toContain("select")
})
