import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type Run = { argv: readonly string[]; init?: { readonly cwd?: string } }
type Out = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } }
const out = (stdout: string, exitCode: number): Out => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
// tsc output: diagnostics, then the --listFiles program list.
const tscOut = (diags: string[], listed = ['/p/src/a.ts', '/p/src/b.ts']) =>
  out([...diags, ...listed].join('\n'), diags.length > 0 ? 2 : 0)

// A fake project: which paths exist, what files say, and how each checker answers in turn.
function project(on: On, files: Record<string, string>, answers: Out[] | ((run: Run) => Out)) {
  const runs: Run[] = []
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, init: e.init })
    if (typeof answers === 'function') return answers({ argv: e.argv, init: e.init })
    return answers[Math.min(runs.length, answers.length) - 1] ?? out('', 0)
  })
  return runs
}

const TS_PROJECT = {
  '/p/.git': '',
  '/p/src/a.ts': '',
  '/p/tsconfig.json': '{ // comment\n "compilerOptions": { "strict": true, }, "include": ["src"], "exclude": ["**/*.spec.ts"] }',
  '/p/node_modules/typescript/bin/tsc': '',
}
const edit = { tool: 'Edit' as const, file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' }
const ok = () => ({ result: { staged: false } })
const note = (ran: { context?: readonly string[] }) => (ran.context ?? []).join('\n')

test('the first edit is diffed against a baseline taken just before it', async ($, on) => {
  on('tool.call', ok)
  const runs = project(on, TS_PROJECT, [
    tscOut(['src/a.ts(1,1): error TS1: old one.']),
    tscOut(["src/a.ts(9,1): error TS1: old one.", "src/a.ts(3,7): error TS2322: Type 'string' is not assignable.", '  continuation']),
  ])
  const ran = await $.tool.call(edit)
  expect(runs.length).toBe(2)
  expect(note(ran)).toMatch(/introduced by this edit:\n\[tsc\] src\/a.ts:3:7 TS2322/)
  expect(note(ran)).toMatch(/continuation/)
  expect(note(ran)).toMatch(/1 other error was already in a.ts/)
  expect(runs[0]?.argv).toContain('--listFiles')
  expect(runs[0]?.argv).toContain('/p/tsconfig.json')
  expect(runs[0]?.argv[0]).toBe('/p/node_modules/typescript/bin/tsc')
})

test('breaking another file on the very first edit is reported', async ($, on) => {
  on('tool.call', ok)
  project(on, TS_PROJECT, [tscOut([]), tscOut(["src/b.ts(1,1): error TS2304: Cannot find name 'x'."])])
  const ran = await $.tool.call(edit)
  expect(note(ran)).toMatch(/other files[^\n]*\n\[tsc\] src\/b.ts:1:1 TS2304/)
})

test('a second identical error is still new', async ($, on) => {
  on('tool.call', ok)
  project(on, TS_PROJECT, [
    tscOut(["src/a.ts(1,1): error TS2304: Cannot find name 'x'."]),
    tscOut(["src/a.ts(1,1): error TS2304: Cannot find name 'x'.", "src/a.ts(5,1): error TS2304: Cannot find name 'x'."]),
  ])
  const ran = await $.tool.call(edit)
  expect(note(ran)).toMatch(/introduced by this edit:\n\[tsc\] src\/a.ts:5:1 TS2304/)
})

test('solution configs are followed: references with files omitted, or empty files and include, nested', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      '/p/.git': '',
      '/p/tsconfig.json': '{ "references": [{ "path": "./tsconfig.node.json" }, { "path": "./packages" }] }',
      '/p/tsconfig.node.json': '{ "include": ["vite.config.ts"] }',
      '/p/packages/tsconfig.json': '{ "files": [], "include": [], "references": [{ "path": "./app" }] }',
      '/p/packages/app/tsconfig.json': '{ "include": ["src/**/*.ts"] }',
      '/p/node_modules/.bin/tsc': '',
    },
    () => tscOut([], ['/p/packages/app/src/a.ts']),
  )
  await $.tool.call({ ...edit, file_path: '/p/packages/app/src/a.ts' })
  expect(runs[0]?.argv).toContain('/p/packages/app/tsconfig.json')
})

test('globs: a wildcard exclude does not exclude everything; a file no glob takes is left to --listFiles', async ($, on) => {
  on('tool.call', ok)
  const runs = project(on, { ...TS_PROJECT, '/p/tsconfig.json': '{ "include": ["src/**/*.ts"], "exclude": ["**/*.spec.ts"] }' }, [
    tscOut([]),
    tscOut(['src/a.ts(2,2): error TS2322: bad.']),
    tscOut(['src/a.ts(2,2): error TS2322: bad.'], ['/p/src/a.ts']),
  ])
  const first = await $.tool.call(edit)
  expect(note(first)).toMatch(/TS2322/)
  expect(runs.length).toBe(2)
  // App.tsx is rooted by no glob; tsc still runs and its file list (no App.tsx) decides.
  const tsx = await $.tool.call({ ...edit, file_path: '/p/src/App.tsx' })
  expect(runs[2]?.argv).toContain('/p/tsconfig.json')
  expect(note(tsx)).toBe('')
})

test('a config whose include comes through extends, beside references, has its own program', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      ...TS_PROJECT,
      '/p/tsconfig.json': '{ "extends": ["./tsconfig.other.json", "./tsconfig.base.json"], "references": [{ "path": "./packages/app" }] }',
      '/p/tsconfig.other.json': '{ "include": ["nothing"] }',
      '/p/tsconfig.base.json': '{ "include": ["src"] }',
      '/p/packages/app/tsconfig.json': '{ "include": ["src"] }',
    },
    () => tscOut([]),
  )
  await $.tool.call(edit)
  expect(runs[0]?.argv).toContain('/p/tsconfig.json')
})

test('extends from a package and checkJs bring a .js file into tsc', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      ...TS_PROJECT,
      '/p/tsconfig.json': '{ "extends": "@acme/tsconfig/base.json", "include": ["src"] }',
      '/p/node_modules/@acme/tsconfig/base.json': '{ "compilerOptions": { "checkJs": true } }',
    },
    () => tscOut([], ['/p/src/a.js']),
  )
  await $.tool.call({ ...edit, file_path: '/p/src/a.js' })
  expect(runs[0]?.argv).toContain('/p/tsconfig.json')
})

test('paths are compared through their real spelling', async ($, on) => {
  on('tool.call', ok)
  on('fs.stat', (_$, e) => ({
    value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/^\/tmp\/p/, '/p') },
  }))
  project(on, TS_PROJECT, [tscOut([]), tscOut(['src/a.ts(1,1): error TS2322: bad.'])])
  const ran = await $.tool.call({ ...edit, file_path: '/tmp/p/src/a.ts' })
  expect(note(ran)).toMatch(/introduced by this edit:\n\[tsc\] src\/a.ts:1:1 TS2322/)
})

test('an unbuilt project reference does not hide a real new error', async ($, on) => {
  on('tool.call', ok)
  const unbuilt = "src/a.ts(1,20): error TS6305: Output file '/p/lib/x.d.ts' has not been built from source file."
  project(on, TS_PROJECT, [tscOut([unbuilt]), tscOut([unbuilt, 'src/a.ts(2,14): error TS2322: bad.'])])
  const ran = await $.tool.call(edit)
  expect(note(ran)).toMatch(/TS2322/)
  expect(note(ran)).not.toMatch(/introduced by this edit:\n[^\n]*TS6305/)
})

test('when the baseline could not be taken, old errors are not reported as new', async ($, on) => {
  on('tool.call', ok)
  project(on, TS_PROJECT, [out('', 99), tscOut(['src/a.ts(1,1): error TS1: old.'])])
  const ran = await $.tool.call(edit)
  expect(note(ran)).toBe('')
})

test('references with files and include omitted still have their own program', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      '/p/.git': '',
      '/p/node_modules/.bin/tsc': '',
      '/p/packages/app/tsconfig.json': '{ "compilerOptions": { "strict": true }, "references": [{ "path": "../shared" }] }',
      '/p/packages/shared/tsconfig.json': '{ "include": ["src"] }',
    },
    () => tscOut([], ['/p/packages/app/src/a.ts']),
  )
  await $.tool.call({ ...edit, file_path: '/p/packages/app/src/a.ts' })
  expect(runs[0]?.argv).toContain('/p/packages/app/tsconfig.json')
})

test('a package config named by package.json "tsconfig" is followed', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      ...TS_PROJECT,
      '/p/tsconfig.json': '{ "extends": "@acme/config", "include": ["src"] }',
      '/p/node_modules/@acme/config/package.json': '{ "tsconfig": "./base.json" }',
      '/p/node_modules/@acme/config/base.json': '{ "compilerOptions": { "checkJs": true } }',
    },
    () => tscOut([], ['/p/src/a.js']),
  )
  await $.tool.call({ ...edit, file_path: '/p/src/a.js' })
  expect(runs[0]?.argv).toContain('/p/tsconfig.json')
})

test('a cut-off run is diffed but does not replace the baseline', async ($, on) => {
  on('tool.call', ok)
  const cut = (o: Out): Out => ({ value: { ...o.value, isStdoutTruncated: true } })
  project(on, TS_PROJECT, [
    tscOut(['src/a.ts(1,1): error TS1: one.', 'src/b.ts(1,1): error TS2: two.']),
    cut(tscOut(['src/a.ts(1,1): error TS1: one.'], [])),
    tscOut(['src/a.ts(1,1): error TS1: one.', 'src/b.ts(1,1): error TS2: two.']),
  ])
  await $.tool.call(edit)
  const third = await $.tool.call(edit)
  expect(note(third)).toBe('')
})

test('eslint: JSON, errors only, from the config directory; a new file\'s errors are all new', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    { '/r/.git': '', '/r/node_modules/.bin/eslint': '', '/r/packages/app/eslint.config.js': '' },
    () =>
      out(
        JSON.stringify([
          {
            filePath: '/private/r/packages/app/src/x.js',
            messages: [
              { ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 2, column: 9 },
              { ruleId: 'no-console', severity: 1, message: 'Unexpected console.', line: 3, column: 1 },
            ],
          },
        ]),
        1,
      ),
  )
  const ran = await $.tool.call({ tool: 'Write', file_path: '/r/packages/app/src/x.js', content: 'x' })
  expect(runs.length).toBe(1)
  expect(runs[0]?.argv).toContain('json')
  expect(runs[0]?.init?.cwd).toBe('/r/packages/app')
  expect(note(ran)).toMatch(/introduced by this edit:\n\[eslint\] x.js:2:9 semi Missing semicolon/)
  expect(note(ran)).not.toMatch(/no-console/)
})

test('ruff: nested file, JSON output, never fixes', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const runs = project(on, { '/q/.git': '', '/q/pyproject.toml': '', '/q/pkg/app.py': '' }, [
    out('[]', 0),
    out(JSON.stringify([{ code: 'F401', message: '`os` imported but unused', filename: '/q/pkg/app.py', location: { row: 1, column: 8 } }]), 1),
  ])
  const ran = await $.tool.call({ tool: 'Write', file_path: '/q/pkg/app.py', content: 'import os\n' })
  expect(runs[0]?.argv).toContain('--no-fix')
  expect(runs[0]?.init?.cwd).toBe('/q')
  expect(note(ran)).toMatch(/F401/)
})

test('a crashing checker or unreadable config never breaks the edit', async ($, on) => {
  on('tool.call', ok)
  on('fs.exists', (_$, e) => ({ value: e.path in TS_PROJECT }))
  on('fs.read', () => {
    throw new Error('EACCES')
  })
  on('process.run', () => {
    throw new Error('spawn ENOENT')
  })
  const ran = await $.tool.call(edit)
  expect(ran.isError).toBeUndefined()
  expect(note(ran)).toBe('')
})

test('errored, staged and non-code edits get no post-edit check', async ($, on) => {
  let answer: { isError: true; result: string; text: string } | { result: { staged: boolean } } = { isError: true, result: 'no', text: 'no' }
  on('tool.call', () => answer)
  const runs = project(on, TS_PROJECT, () => tscOut([]))
  const failed = await $.tool.call(edit)
  answer = { result: { staged: true } }
  const staged = await $.tool.call(edit)
  answer = { result: { staged: false } }
  await $.tool.call({ ...edit, file_path: '/p/README.md' })
  // Only the baseline before the first edit ran.
  expect(runs.length).toBe(1)
  expect(note(failed) + note(staged)).toBe('')
})

test('the tsc toggle turns tsc off', { options: { tsc: false } }, async ($, on) => {
  on('tool.call', ok)
  const runs = project(on, TS_PROJECT, () => tscOut([]))
  await $.tool.call(edit)
  expect(runs.length).toBe(0)
})
