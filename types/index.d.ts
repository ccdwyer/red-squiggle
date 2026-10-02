// Per checker scope (a tsc project's config, or `eslint:<file>` / `ruff:<file>`): the
// signatures of the errors its last run reported, so the next run can tell new ones.
export type Seen = Record<string, string[]>

declare module 'claude-code' {
  interface PluginState {
    'red-squiggle': { seen: Seen }
  }
}
