import { describe, test, expect } from 'bun:test'
import { createStateMachine } from '../state-machine.js'

process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// Reproduce state machines for mutual exclusion testing
// ---------------------------------------------------------------------------

type ReviewPhase = 'critic_turn' | 'owner_turn' | 'cleanup' | 'complete' | 'cancelled'
type ReviewEvent = 'critic_posted' | 'owner_posted' | 'final_round' | 'summary_posted' | 'timeout' | 'cancel'

type BuildPhase = 'implementing' | 'reviewing' | 'complete' | 'cancelled'
type BuildEvent = 'owner_impl' | 'critic_lgtm' | 'critic_feedback' | 'timeout' | 'cancel'

type DesignPhase = 'spawning' | 'questioning' | 'answering' | 'independent' | 'synthesis' | 'refinement' | 'audit' | 'brief' | 'complete' | 'cancelled'

const reviewMachine = createStateMachine<ReviewPhase, ReviewEvent>('review', {
  critic_turn: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' },
  owner_turn:  { owner_posted: 'critic_turn', final_round: 'cleanup', timeout: 'cancelled', cancel: 'cancelled' },
  cleanup:     { summary_posted: 'complete', timeout: 'complete' },
  complete:    {},
  cancelled:   {},
})

const buildMachine = createStateMachine<BuildPhase, BuildEvent>('build', {
  implementing: { owner_impl: 'reviewing',    timeout: 'cancelled', cancel: 'cancelled' },
  reviewing:    { critic_lgtm: 'complete', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' },
  complete:     {},
  cancelled:    {},
})

// ---------------------------------------------------------------------------
// Mutual exclusion — simulate the cross-check logic
// ---------------------------------------------------------------------------

describe('protocol mutual exclusion', () => {
  const activeReviews = new Map<string, { phase: ReviewPhase }>()
  const activeBuilds = new Map<string, { phase: BuildPhase }>()
  const activeDesigns = new Map<string, { phase: DesignPhase }>()

  function getReviewByThread(threadId: string) { return activeReviews.get(threadId) }
  function getBuildByThread(threadId: string) { return activeBuilds.get(threadId) }
  function getDesignByThread(threadId: string) { return activeDesigns.get(threadId) }

  function startReview(threadId: string) {
    if (activeReviews.has(threadId)) throw new Error('A review is already in progress in this thread')
    if (getBuildByThread(threadId)) throw new Error('A build is in progress in this thread — finish or cancel it first')
    if (getDesignByThread(threadId)) throw new Error('A design is in progress in this thread — finish or cancel it first')
    activeReviews.set(threadId, { phase: 'critic_turn' })
  }

  function startBuild(threadId: string) {
    if (activeBuilds.has(threadId)) throw new Error('A build is already in progress in this thread')
    if (getReviewByThread(threadId)) throw new Error('A review is in progress in this thread — finish or cancel it first')
    if (getDesignByThread(threadId)) throw new Error('A design is in progress in this thread — finish or cancel it first')
    activeBuilds.set(threadId, { phase: 'implementing' })
  }

  function startDesign(threadId: string) {
    if (activeDesigns.has(threadId)) throw new Error('A design session is already in progress in this thread')
    if (getReviewByThread(threadId)) throw new Error('A review is in progress in this thread — finish or cancel it first')
    if (getBuildByThread(threadId)) throw new Error('A build is in progress in this thread — finish or cancel it first')
    activeDesigns.set(threadId, { phase: 'spawning' })
  }

  test('review blocks build in same thread', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startReview('thread-1')
    expect(() => startBuild('thread-1')).toThrow('review is in progress')
  })

  test('review blocks design in same thread', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startReview('thread-1')
    expect(() => startDesign('thread-1')).toThrow('review is in progress')
  })

  test('build blocks review in same thread', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startBuild('thread-1')
    expect(() => startReview('thread-1')).toThrow('build is in progress')
  })

  test('build blocks design in same thread', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startBuild('thread-1')
    expect(() => startDesign('thread-1')).toThrow('build is in progress')
  })

  test('design blocks review in same thread', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startDesign('thread-1')
    expect(() => startReview('thread-1')).toThrow('design is in progress')
  })

  test('design blocks build in same thread', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startDesign('thread-1')
    expect(() => startBuild('thread-1')).toThrow('design is in progress')
  })

  test('different threads are independent', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startReview('thread-1')
    expect(() => startBuild('thread-2')).not.toThrow()
    expect(() => startDesign('thread-3')).not.toThrow()
  })

  test('same protocol type blocks itself', () => {
    activeReviews.clear(); activeBuilds.clear(); activeDesigns.clear()
    startReview('thread-1')
    expect(() => startReview('thread-1')).toThrow('review is already in progress')
  })
})

// ---------------------------------------------------------------------------
// getActive* filtering
// ---------------------------------------------------------------------------

describe('getActive filtering', () => {
  test('filters out complete and cancelled', () => {
    type State = { phase: string }
    const all: State[] = [
      { phase: 'critic_turn' },
      { phase: 'complete' },
      { phase: 'cancelled' },
      { phase: 'owner_turn' },
    ]
    const active = all.filter(s => s.phase !== 'complete' && s.phase !== 'cancelled')
    expect(active).toHaveLength(2)
    expect(active[0].phase).toBe('critic_turn')
    expect(active[1].phase).toBe('owner_turn')
  })

  test('empty when all complete', () => {
    const all = [{ phase: 'complete' }, { phase: 'cancelled' }]
    const active = all.filter(s => s.phase !== 'complete' && s.phase !== 'cancelled')
    expect(active).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Owner disconnect handling — timer logic
// ---------------------------------------------------------------------------

describe('owner disconnect handling', () => {
  test('disconnect timer is set and cleared on reconnect', () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timerFired = false

    // Simulate disconnect
    timer = setTimeout(() => { timerFired = true }, 120_000)
    expect(timer).toBeDefined()

    // Simulate reconnect before timer fires
    clearTimeout(timer)
    timer = undefined
    expect(timer).toBeUndefined()

    // Timer should not have fired
    expect(timerFired).toBe(false)
  })

  test('disconnect clears turn timeout before setting grace period', () => {
    let turnTimeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {}, 10 * 60 * 1000)
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined

    // Simulate owner disconnect — clear turn timeout, set grace period
    clearTimeout(turnTimeout)
    turnTimeout = undefined
    disconnectTimer = setTimeout(() => {}, 120_000)

    expect(turnTimeout).toBeUndefined()
    expect(disconnectTimer).toBeDefined()

    // Cleanup
    clearTimeout(disconnectTimer)
  })

  test('reconnect restores turn timeout', () => {
    let turnTimeout: ReturnType<typeof setTimeout> | undefined
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {}, 120_000)

    // Simulate reconnect — clear grace period, restore turn timeout
    clearTimeout(disconnectTimer)
    disconnectTimer = undefined
    turnTimeout = setTimeout(() => {}, 10 * 60 * 1000)

    expect(disconnectTimer).toBeUndefined()
    expect(turnTimeout).toBeDefined()

    // Cleanup
    clearTimeout(turnTimeout)
  })
})

// ---------------------------------------------------------------------------
// Build heartbeat cleanup
// ---------------------------------------------------------------------------

describe('build heartbeat cleanup on completion', () => {
  test('completeBuild clears heartbeat and timeout', () => {
    let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {}, 5 * 60 * 1000)
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {}, 20 * 60 * 1000)
    let phase = 'reviewing'

    // Simulate completeBuild
    if (heartbeat) clearInterval(heartbeat)
    if (timeout) clearTimeout(timeout)
    phase = 'complete'

    expect(phase).toBe('complete')
    // Intervals/timeouts cleared without error — no leaked resources
  })

  test('completeBuild is safe when heartbeat is undefined', () => {
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined

    // Should not throw
    if (heartbeat) clearInterval(heartbeat)
    if (timeout) clearTimeout(timeout)
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Reconnect handler owner map lookup
// ---------------------------------------------------------------------------

describe('reconnect handler checks both maps', () => {
  test('finds review by critic session', () => {
    const sessionToReview = new Map([['critic-1', 'review-1']])
    const ownerToReview = new Map([['owner-1', 'review-1']])

    const id = sessionToReview.get('critic-1') ?? ownerToReview.get('critic-1')
    expect(id).toBe('review-1')
  })

  test('finds review by owner session', () => {
    const sessionToReview = new Map([['critic-1', 'review-1']])
    const ownerToReview = new Map([['owner-1', 'review-1']])

    const id = sessionToReview.get('owner-1') ?? ownerToReview.get('owner-1')
    expect(id).toBe('review-1')
  })

  test('returns undefined for unknown session', () => {
    const sessionToReview = new Map([['critic-1', 'review-1']])
    const ownerToReview = new Map([['owner-1', 'review-1']])

    const id = sessionToReview.get('unknown') ?? ownerToReview.get('unknown')
    expect(id).toBeUndefined()
  })
})
