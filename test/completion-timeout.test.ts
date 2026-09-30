import { afterEach, expect, test } from "bun:test"
import {
  clearFileCompletionCache,
  fileCompletionCandidates,
  fileCompletionCandidatesBounded,
} from "../src/kernel/completion"
import { setPlatformRuntime, type StatLike } from "../src/platform/runtime"

// A remote mount (NFS, SMB, sshfs) answers readdir in seconds. find-file completion runs from
// post-command-hook, which the key loop awaits, so an unbounded await froze typing for that long.
// These tests pin the time bound and the repaint contract that replaced it.

afterEach(() => {
  setPlatformRuntime(undefined)
  clearFileCompletionCache()
})

const S_IFDIR = 0o040000
const S_IFREG = 0o100644

function slowRuntime(delayMs: number, counters: { readdir: number; stat: number }) {
  setPlatformRuntime({
    cwd: () => "/slow",
    homedir: () => "/slow",
    readdir: async () => {
      counters.readdir++
      await Bun.sleep(delayMs)
      return ["alpha", "beta"]
    },
    stat: async (path: string): Promise<StatLike | null> => {
      counters.stat++
      await Bun.sleep(delayMs)
      return { mode: path.endsWith("beta") ? S_IFDIR : S_IFREG, size: 0, mtime: 0 }
    },
  })
}

test("a slow directory returns inside the time budget instead of blocking", async () => {
  const counters = { readdir: 0, stat: 0 }
  slowRuntime(500, counters)
  const started = Date.now()
  const result = await fileCompletionCandidatesBounded("/slow/", "/slow", { timeoutMs: 50 })
  const elapsed = Date.now() - started
  expect(elapsed).toBeLessThan(400)
  expect(result.pending).toBe(true)
  expect(result.candidates).toEqual([])
  expect(result.settled).not.toBeNull()
})

test("the second query after `settled` returns the full listing from cache", async () => {
  const counters = { readdir: 0, stat: 0 }
  slowRuntime(100, counters)
  const first = await fileCompletionCandidatesBounded("/slow/", "/slow", { timeoutMs: 10 })
  expect(first.pending).toBe(true)
  await first.settled
  const second = await fileCompletionCandidatesBounded("/slow/", "/slow", { timeoutMs: 10 })
  expect(second.pending).toBe(false)
  expect(second.candidates).toEqual(["/slow/alpha", "/slow/beta/"])
  expect(counters.readdir).toBe(1)
})

test("keystrokes during one slow listing share it instead of starting more", async () => {
  const counters = { readdir: 0, stat: 0 }
  slowRuntime(100, counters)
  const queries = await Promise.all([
    fileCompletionCandidatesBounded("/slow/a", "/slow", { timeoutMs: 5 }),
    fileCompletionCandidatesBounded("/slow/al", "/slow", { timeoutMs: 5 }),
    fileCompletionCandidatesBounded("/slow/alp", "/slow", { timeoutMs: 5 }),
  ])
  expect(queries.every(q => q.pending)).toBe(true)
  expect(counters.readdir).toBe(1)
})

test("a cached listing answers with timeoutMs 0", async () => {
  const counters = { readdir: 0, stat: 0 }
  slowRuntime(50, counters)
  const first = await fileCompletionCandidatesBounded("/slow/", "/slow", { timeoutMs: 0 })
  expect(first.pending).toBe(true)
  await first.settled
  const cached = await fileCompletionCandidatesBounded("/slow/", "/slow", { timeoutMs: 0 })
  expect(cached.pending).toBe(false)
  expect(cached.candidates.length).toBe(2)
})

test("fileCompletionCandidates still waits for the whole listing", async () => {
  const counters = { readdir: 0, stat: 0 }
  slowRuntime(30, counters)
  const candidates = await fileCompletionCandidates("/slow/", "/slow")
  expect(candidates).toEqual(["/slow/alpha", "/slow/beta/"])
})

test("readdirTypes marks directories without one stat per entry", async () => {
  let stats = 0
  setPlatformRuntime({
    cwd: () => "/typed",
    homedir: () => "/typed",
    readdir: async () => ["one", "two", "link"],
    readdirTypes: async () => [
      { name: "one", directory: false },
      { name: "two", directory: true },
      { name: "link", directory: null },
    ],
    stat: async () => { stats++; return { mode: S_IFREG, size: 0, mtime: 0 } },
  })
  const result = await fileCompletionCandidatesBounded("/typed/", "/typed", { timeoutMs: 1000 })
  expect(result.candidates).toEqual(["/typed/link", "/typed/one", "/typed/two/"])
  // Only the symlink needs a stat; the other two came from the single readdirTypes call.
  expect(stats).toBe(1)
})

test("a write drops the cached listing of its parent directory", async () => {
  let names = ["alpha"]
  setPlatformRuntime({
    cwd: () => "/w",
    homedir: () => "/w",
    readdir: async () => names,
    stat: async () => ({ mode: S_IFREG, size: 0, mtime: 0 }),
    writeFileText: async () => {},
  })
  const before = await fileCompletionCandidatesBounded("/w/", "/w", { timeoutMs: 1000 })
  expect(before.candidates).toEqual(["/w/alpha"])
  names = ["alpha", "gamma"]
  const { writeFileText } = await import("../src/platform/runtime")
  await writeFileText("/w/gamma", "hi")
  const after = await fileCompletionCandidatesBounded("/w/", "/w", { timeoutMs: 1000 })
  expect(after.candidates).toEqual(["/w/alpha", "/w/gamma"])
})
