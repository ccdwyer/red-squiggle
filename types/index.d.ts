// What one checker scope (a tsc config, or `eslint:<file>` / `ruff:<file>`) reported on its
// latest run: how many times each error signature occurred, and the run's sequence number,
// so an older run finishing late never replaces a newer baseline.
export type Baseline = { seq: number; counts: Record<string, number> }

declare module 'claude-code' {
  interface PluginState {
    'red-squiggle': { seen: Record<string, Baseline> }
  }
}
