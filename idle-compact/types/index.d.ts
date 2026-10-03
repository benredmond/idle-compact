export type IdleCompactState = {
  lastMainRequestAt: number | null
  turnRunning: boolean
  /** Status held once this idle stretch is done (compacted, vetoed, gave up); cleared by the next turn. */
  latched: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'idle-compact': { idle: IdleCompactState }
  }
}
