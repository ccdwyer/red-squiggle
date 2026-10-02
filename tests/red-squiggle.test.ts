import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type Run = { argv: readonly string[]; init?: { readonly cwd?: string } }
const out = (stdout: string, exitCode: number) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A fake project: which paths exist, what files say, and how each checker answers.
function project(
  on: On,
  files: Record<string, string>,
  answer: (run: Run) => { value: ReturnType<typeof out>['value'] } | never,
) {
  const runs: Run[] = []
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, init: e.init })
    return answer({ argv: e.argv, init: e.init })
  })
  return runs
}

const TS_PROJECT = {
  '/p/.git': '',
  '/p/tsconfig.json': '{ // comment\n "compilerOptions": { "strict": true, }, "include": ["src"] }',
  '/p/node_modules/typescript/bin/tsc': '',
}
const edit = { tool: 'Edit' as const, file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' }
const ok = () => ({ result: { staged: false } })
const note = (ran: { context?: readonly string[] }) => (ran.context ?? []).join('\n')

test('first check: this file\'s errors are shown as possibly older, other files only baseline', async ($, on) => {
  on('tool.call', ok)
  const runs = project(on, TS_PROJECT, () =>
    out("src/a.ts(3,7): error TS2322: Type 'string' is not assignable.\n  continuation\nsrc/b.ts(1,1): error TS2304: Cannot find name 'x'.", 2),
  )
  const ran = await $.tool.call(edit)
  expect(note(ran)).toMatch(/first check this session/)
  expect(note(ran)).toMatch(/TS2322/)
  expect(note(ran)).toMatch(/continuation/)
  expect(note(ran)).not.toMatch(/TS2304/)
  expect(runs[0]?.argv[0]).toBe('/p/node_modules/typescript/bin/tsc')
  expect(runs[0]?.argv).toContain('--incremental')
  expect(runs[0]?.argv).toContain('/p/tsconfig.json')
})

test('later checks report only new errors, here and elsewhere', async ($, on) => {
  on('tool.call', ok)
  let step = 0
  project(on, TS_PROJECT, () => {
    step += 1
    return step === 1
      ? out('src/a.ts(3,7): error TS1: old one.', 2)
      : out('src/a.ts(9,9): error TS1: old one.\nsrc/a.ts(4,1): error TS2: new here.\nsrc/b.ts(1,1): error TS3: broke b.', 2)
  })
  await $.tool.call(edit)
  const ran = await $.tool.call(edit)
  expect(note(ran)).toMatch(/introduced by this edit:\n\[tsc\] src\/a.ts:4:1 TS2 new here/)
  expect(note(ran)).toMatch(/other files[^\n]*\n\[tsc\] src\/b.ts:1:1 TS3/)
  expect(note(ran)).toMatch(/1 other error was already present/)
})

test('a solution tsconfig is followed to the referenced config that holds the file', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      '/p/.git': '',
      '/p/tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }] }',
      '/p/tsconfig.node.json': '{ "include": ["vite.config.ts"] }',
      '/p/tsconfig.app.json': '{ "include": ["src/**/*"] }',
      '/p/node_modules/.bin/tsc': '',
    },
    () => out('', 0),
  )
  await $.tool.call(edit)
  expect(runs[0]?.argv).toContain('/p/tsconfig.app.json')
})

test('a file outside the program is not checked and not called clean', async ($, on) => {
  on('tool.call', ok)
  const runs = project(on, TS_PROJECT, () => out('', 0))
  const ran = await $.tool.call({ ...edit, file_path: '/p/scripts/tool.ts' })
  expect(runs.length).toBe(0)
  expect(note(ran)).toBe('')
})

test('eslint: JSON output, errors only, run from the config directory', async ($, on) => {
  on('tool.call', ok)
  const runs = project(
    on,
    {
      '/r/.git': '',
      '/r/node_modules/.bin/eslint': '',
      '/r/packages/app/eslint.config.js': '',
    },
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
  expect(runs[0]?.argv).toContain('json')
  expect(runs[0]?.init?.cwd).toBe('/r/packages/app')
  expect(note(ran)).toMatch(/semi Missing semicolon/)
  expect(note(ran)).not.toMatch(/no-console/)
})

test('ruff: nested file, JSON output, never fixes', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const runs = project(on, { '/q/.git': '', '/q/pyproject.toml': '' }, () =>
    out(JSON.stringify([{ code: 'F401', message: '`os` imported but unused', filename: '/q/pkg/app.py', location: { row: 1, column: 8 } }]), 1),
  )
  const ran = await $.tool.call({ tool: 'Write', file_path: '/q/pkg/app.py', content: 'import os\n' })
  expect(runs[0]?.argv).toContain('--no-fix')
  expect(runs[0]?.init?.cwd).toBe('/q')
  expect(note(ran)).toMatch(/F401/)
})

test('a crashing checker or unreadable config never breaks the edit', async ($, on) => {
  on('tool.call', ok)
  let tries = 0
  on('fs.exists', (_$, e) => ({ value: e.path in TS_PROJECT }))
  on('fs.read', () => {
    throw new Error('EACCES')
  })
  on('process.run', () => {
    tries += 1
    throw new Error('spawn ENOENT')
  })
  const ran = await $.tool.call(edit)
  expect(tries).toBe(1)
  expect(ran.isError).toBeUndefined()
  expect(note(ran)).toBe('')
})

test('errored, staged and non-code edits run no checker', async ($, on) => {
  let answer: { isError: true; result: string; text: string } | { result: { staged: boolean } } = { isError: true, result: 'no', text: 'no' }
  on('tool.call', () => answer)
  const runs = project(on, TS_PROJECT, () => out('', 0))
  await $.tool.call(edit)
  answer = { result: { staged: true } }
  await $.tool.call(edit)
  answer = { result: { staged: false } }
  await $.tool.call({ ...edit, file_path: '/p/README.md' })
  expect(runs.length).toBe(0)
})

test('the tsc toggle turns tsc off', { options: { tsc: false } }, async ($, on) => {
  on('tool.call', ok)
  const runs = project(on, TS_PROJECT, () => out('', 0))
  await $.tool.call(edit)
  expect(runs.length).toBe(0)
})
