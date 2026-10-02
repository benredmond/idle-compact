export type IdleCompactState = {
  lastMainRequestAt: number | null
  turnRunning: boolean
  compactedSinceLastTurn: boolean
  /** Status shown while latched: why idle-compact is waiting for the next turn. */
  latchedStatus: string
}

declare module 'claude-code' {
  interface PluginState {
    'idle-compact': { idle: IdleCompactState }
  }
}
