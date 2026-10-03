import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { IdleCompactState } from '../types'

const MINUTE = 60_000
const TICK_MS = 30_000
const MAX_ATTEMPTS = 3

const idle = atom({ plugin: 'idle-compact', key: 'idle' } as const, {
  lastMainRequestAt: null,
  turnRunning: false,
  latched: null,
} as IdleCompactState)

const minutes = (ms: number) => (ms < MINUTE ? '<1m' : `${Math.ceil(ms / MINUTE)}m`)
const kTokens = (n: number) => `${Math.round(n / 1000)}k`

// The countdown's glyph fills as compaction nears: ○ ◔ ◑ ◕.
const PIE = ['○', '◔', '◑', '◕']
const countdown = (dueInMs: number, windowMs: number) =>
  `${PIE[Math.min(PIE.length - 1, Math.floor(((windowMs - dueInMs) / windowMs) * PIE.length))]} ${minutes(dueInMs)}`

type Config = {
  ttlMs: number
  marginMs: number
  minContextTokens: number
  instructions: string | undefined
}

let isCompacting = false
let isHeadless = false
let failedAttempts = 0
let headlessCounts: { tokensBefore?: number; tokensAfter?: number } | undefined

async function latch($: EngineInterface, status: string) {
  await update($, idle, s => ({ ...s, latched: status }))
  $.ui.status(status)
}

// Headless sessions (-p, the SDK, the desktop app) refuse $.session.compact; there
// /compact runs as a command instead.
async function compact($: EngineInterface, cfg: Config) {
  if (!isHeadless) return $.session.compact({ instructions: cfg.instructions })
  await $.command.run({ command: 'compact', args: cfg.instructions ?? '' })
  return undefined
}

// One tick both draws the countdown and, once due, compacts. The status line shows
// only what idle-compact will do or did; reasons go to the debug log.
async function tick($: EngineInterface, cfg: Config) {
  const s = await read($, idle)
  if (s.turnRunning || s.lastMainRequestAt === null) return $.ui.status(undefined)
  if (s.latched !== null) return $.ui.status(s.latched)

  const idleMs = (await $.clock.now()) - s.lastMainRequestAt
  // Cache already cold (e.g. the machine slept): compacting now saves nothing.
  if (idleMs >= cfg.ttlMs) return $.ui.status(undefined)
  if (((await $.session.usage()).context.tokens ?? 0) < cfg.minContextTokens) return $.ui.status(undefined)

  const windowMs = cfg.ttlMs - cfg.marginMs
  const dueInMs = windowMs - idleMs
  if (dueInMs > 0) return $.ui.status(countdown(dueInMs, windowMs))
  if (isCompacting) return

  isCompacting = true
  headlessCounts = undefined
  $.ui.status('⟳')
  try {
    const result = await compact($, cfg)
    if (result?.skip !== undefined) {
      // Vetoed by another hook: latch anyway so the veto is not retried every tick.
      $.ui.log(`idle-compact: compact skipped: ${result.skip}`, { to: 'debug' })
      await latch($, '⊘')
      return
    }
    // Our own compact() skips our session.compact hook, so latch here too.
    const counts = result ?? headlessCounts
    const after = counts?.tokensAfter
    await latch($, after === undefined ? '✓' : `✓ ${kTokens(counts?.tokensBefore ?? 0)}→${kTokens(after)}`)
  } catch (err) {
    // compact() rejects while a turn runs or the summary request fails: retry
    // on the next ticks, then give up for this idle stretch.
    failedAttempts += 1
    const reason = (err instanceof Error ? err.message : String(err)).replace(/^idle-compact: /, '')
    $.ui.log(`idle-compact: compact failed (${failedAttempts}/${MAX_ATTEMPTS}): ${reason}`, { to: 'debug' })
    if (failedAttempts >= MAX_ATTEMPTS) await latch($, '✗')
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
    isHeadless = !e.isInteractive
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($, cfg))
    void tick($, cfg)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    failedAttempts = 0
    await update($, idle, s => ({ ...s, turnRunning: true, latched: null }))
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
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.skip !== undefined) return result
    if (isCompacting) {
      // Our own headless /compact: tick() latches, with the counts only this hook sees.
      headlessCounts = result
    } else if (!(await read($, idle)).turnRunning) {
      await latch($, '✓')
    }
    return result
  })
}
