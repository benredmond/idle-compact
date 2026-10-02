import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { IdleCompactState } from '../types'

const MINUTE = 60_000
const TICK_MS = 30_000

const idle = atom({ plugin: 'idle-compact', key: 'idle' } as const, {
  lastMainRequestAt: null,
  turnRunning: false,
  compactedSinceLastTurn: false,
  latchedStatus: '',
} as IdleCompactState)

const minutes = (ms: number) => (ms < MINUTE ? '<1m' : `${Math.ceil(ms / MINUTE)}m`)
const kTokens = (n: number) => `${Math.round(n / 1000)}k`

type Config = {
  ttlMs: number
  marginMs: number
  minContextTokens: number
  instructions: string | undefined
}

let isCompacting = false
let failedAttempts = 0
const MAX_ATTEMPTS = 3
const COMPACTED = 'idle-compact: compacted · waits for next turn'

function latch($: EngineInterface, status: string) {
  return update($, idle, s => ({ ...s, compactedSinceLastTurn: true, latchedStatus: status }))
}

// One tick both draws the countdown and, once due, compacts.
async function tick($: EngineInterface, cfg: Config) {
  const s = await read($, idle)
  if (s.turnRunning || s.lastMainRequestAt === null) {
    $.ui.status(undefined)
    return
  }
  if (s.compactedSinceLastTurn) {
    $.ui.status(s.latchedStatus || COMPACTED)
    return
  }

  const idleMs = (await $.clock.now()) - s.lastMainRequestAt
  if (idleMs >= cfg.ttlMs) {
    // Cache already cold (e.g. the machine slept): compacting now saves nothing.
    $.ui.status('idle-compact: cache expired · skipped')
    return
  }

  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (tokens < cfg.minContextTokens) {
    $.ui.status(`idle-compact: off · ctx ${kTokens(tokens)} < ${kTokens(cfg.minContextTokens)}`)
    return
  }

  const dueInMs = cfg.ttlMs - cfg.marginMs - idleMs
  if (dueInMs > 0) {
    $.ui.status(`idle-compact in ${minutes(dueInMs)} · cache ${minutes(cfg.ttlMs - idleMs)}`)
    return
  }
  if (isCompacting) return

  isCompacting = true
  $.ui.status('idle-compact: compacting…')
  try {
    const result = await $.session.compact({ instructions: cfg.instructions })
    if (result.skip !== undefined) {
      // Vetoed by another hook: latch anyway so the veto is not retried every tick.
      const status = `idle-compact: skipped · ${result.skip}`
      await latch($, status)
      $.ui.status(status)
      return
    }
    // Our own compact() skips our session.compact hook, so latch here too.
    await latch($, COMPACTED)
    const before = result.tokensBefore ?? tokens
    const after = result.tokensAfter
    $.ui.toast(
      `idle-compact: ${kTokens(before)}${after === undefined ? '' : ` → ${kTokens(after)}`} tokens while cache warm`,
      { timeoutMs: 10_000 },
    )
    $.ui.status(COMPACTED)
  } catch {
    // compact() rejects while a turn runs or the summary request fails: retry
    // on the next ticks, then give up for this idle stretch.
    failedAttempts += 1
    if (failedAttempts >= MAX_ATTEMPTS) {
      const status = `idle-compact: failed ${failedAttempts}x · waits for next turn`
      await latch($, status)
      $.ui.status(status)
    } else {
      $.ui.status('idle-compact: busy · retrying')
    }
  } finally {
    isCompacting = false
  }
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    ttlMs: Number(options.ttlMinutes ?? 60) * MINUTE,
    marginMs: Number(options.marginMinutes ?? 5) * MINUTE,
    minContextTokens: Number(options.minContextTokens ?? 40_000),
    instructions: String(options.instructions ?? '').trim() || undefined,
  }

  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($, cfg))
    void tick($, cfg)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    failedAttempts = 0
    await update($, idle, s => ({ ...s, turnRunning: true, compactedSinceLastTurn: false }))
    $.ui.status(undefined)
    return next(e)
  })

  // Every main-loop request renews the cache; anchor the TTL at request start.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, idle, s => ({ ...s, lastMainRequestAt: now }))
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, idle, s => ({ ...s, turnRunning: false }))
      void tick($, cfg)
    }
    return result
  })

  // A main-conversation compaction between turns (manual /compact) latches until a
  // real turn runs; one mid-turn (auto) is followed by more work, so it does not.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const isBetweenTurns = !(await read($, idle)).turnRunning
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined && isBetweenTurns) {
      await latch($, COMPACTED)
      void tick($, cfg)
    }
    return result
  })
}
