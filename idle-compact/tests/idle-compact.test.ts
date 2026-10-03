import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MIN = 60_000
const summary: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }

type World = {
  failCompact: boolean
  throwCompact: boolean
  compacts: number
  instructions: (string | undefined)[]
  commands: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  tokens: number
}

function world(on: On, tokens = 120_000): World {
  const w: World = { failCompact: false, throwCompact: false, compacts: 0, instructions: [], commands: [], statuses: [], toasts: [], tokens }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.tokens, window: 200_000 }, rateLimits: [] } }))
  on('session.compact', (_$, e) => {
    w.compacts += 1
    w.instructions.push(e.instructions)
    if (w.throwCompact) throw new Error('summary request failed')
    if (w.failCompact) return { skip: 'api down' }
    return { messages: [summary], tokensBefore: w.tokens, tokensAfter: 12_000 }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('command.run', (_$, e) => {
    w.commands.push(e.args ? `/${e.command} ${e.args}` : `/${e.command}`)
    return {}
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

async function runTurn($: Engine, turnId: string, agentId?: string) {
  if (agentId === undefined) await $.turn.start({ text: 'hi', turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', messageCount: 3, agentId })) void _
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, agentId, reason: 'answer' })
}

async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive })
}

test('compacts once at ttl - margin and never again until a new turn', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await runTurn($, 't1')

  await clock.advance(54 * MIN)
  expect(w.compacts).toBe(0)
  expect(w.statuses.at(-1)).toBe('◕ 1m')

  await clock.advance(1.5 * MIN)
  expect(w.compacts).toBe(1)
  expect(w.instructions).toEqual([undefined])
  expect(w.toasts).toEqual([])
  expect(w.statuses.at(-1)).toBe('✓ 120k→12k')

  await clock.advance(3 * 60 * MIN)
  expect(w.compacts).toBe(1)

  await runTurn($, 't2')
  await clock.advance(56 * MIN)
  expect(w.compacts).toBe(2)
})

test('manual /compact latches: no idle compaction follows it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await runTurn($, 't1')
  await clock.advance(10 * MIN)
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  expect(w.compacts).toBe(1)
  await clock.advance(60 * MIN)
  expect(w.compacts).toBe(1)
})

test('never compacts while a turn is running', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await runTurn($, 't1')
  await $.turn.start({ text: 'long one', turnId: 't2' })
  await clock.advance(70 * MIN)
  expect(w.compacts).toBe(0)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('skips sessions below the context floor', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, 20_000)
  await start($)
  await runTurn($, 't1')
  await clock.advance(58 * MIN)
  expect(w.compacts).toBe(0)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('subagent requests do not re-anchor the main cache clock', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await runTurn($, 't1')
  await clock.advance(30 * MIN)
  await runTurn($, 't1', 'sub-1')
  await clock.advance(25.5 * MIN)
  expect(w.compacts).toBe(1)
})

test('a vetoed compaction latches instead of retrying every tick', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.failCompact = true
  await start($)
  await runTurn($, 't1')
  await clock.advance(58 * MIN)
  expect(w.compacts).toBe(1)
  expect(w.statuses.at(-1)).toBe('⊘')
})

test('an auto-compaction mid-turn does not latch the idle stretch after it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($)
  await $.turn.start({ text: 'big task', turnId: 't1' })
  await $.session.compact({ trigger: 'auto', messages: [summary] })
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'opus', messageCount: 3 })) void _
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(56 * MIN)
  expect(w.compacts).toBe(2)
})

test('headless sessions run a plain /compact, once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await start($, false)
  await runTurn($, 't1')
  await clock.advance(56 * MIN)
  expect(w.commands).toEqual(['/compact'])
  expect(w.compacts).toBe(0)
  expect(w.statuses.at(-1)).toBe('✓')
  await clock.advance(3 * 60 * MIN)
  expect(w.commands.length).toBe(1)
})

test('a compaction that keeps failing gives up after three tries', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.throwCompact = true
  await start($)
  await runTurn($, 't1')
  await clock.advance(58 * MIN)
  expect(w.statuses.at(-1)).toBe('✗')
})
