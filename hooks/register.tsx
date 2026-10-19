import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderNode, ToolCallInput } from 'claude-code'

import type { Entry, PastDecision, View } from '../types'

const PANE = 'trail'
const TOOL = 'mcp__trail__decide'
const KEEP = 500
const PAST_KEEP = 200
const PAST_SHOWN = 15
const REMEMBERED = 20
// The newest turns start unfolded; a click flips any turn.
const OPEN_TURNS = 2
const STALE_MS = 30 * 60 * 1000

const entries = atom({ plugin: 'trail', key: 'entries' } as const, [])
const view = atom({ plugin: 'trail', key: 'view' } as const, 'timeline')
const folds = atom({ plugin: 'trail', key: 'folds' } as const, {})
const search = atom({ plugin: 'trail', key: 'search' } as const, '')
const turn = atom({ plugin: 'trail', key: 'turn' } as const, 0)
const past = atom({ plugin: 'trail', key: 'past' } as const, [])
const live = atom({ plugin: 'trail', key: 'live' } as const, {
  startedAt: null,
  now: 0,
  inflight: [],
})

const GUIDE = `# Decision trail
The person follows this session in a trail pane: their asks, the decisions made, and the changes. Keep its decisions complete with ${TOOL}:
- Call it when you settle a non-obvious choice: an approach, design, library, data shape, scope cut, tradeoff, or an assumption you will act on. Call it at the moment of choosing, before acting on it.
- Also call it with by: "user" when the person makes, states or overrides a choice in their message ("use Postgres", "skip tests for now"). Answers to AskUserQuestion and plan approvals are logged automatically; don't repeat them.
- When a decision changes an earlier one (from this session, or listed under "Decisions already made in this project"), pass replaces with the earlier decision's text.
- Skip routine steps (reading files, running a build, fixing a typo). One call per decision, and no need to mention the logging in your reply.
- what: the choice itself, under 80 characters ("SQLite over Postgres for the cache"). why: one short sentence.`

type Decision = {
  by: 'user' | 'claude'
  text: string
  why?: string
  alternatives?: string
  isSubagent?: boolean
}

// The trail's own commands, which answer without a model turn.
const OWN_COMMANDS = new Set(['trail', 'decide'])

// A slash command's line, held until it starts a model turn; one that never
// does (/help, /config) opens no group.
let pendingCommand: string | undefined

// Chains every read-modify-write of the stored decisions, so parallel
// decide calls all land.
let storing: Promise<unknown> = Promise.resolve()

async function shortPath($: EngineInterface, path: string) {
  const cwd = await $.session.cwd()
  if (path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)

  return path.replace(/^\/(?:home|Users)\/[^/]+\//, '~/')
}

async function pastKey($: EngineInterface) {
  return `past:${await $.session.cwd()}`
}

async function changeStored(
  $: EngineInterface,
  change: (list: PastDecision[]) => PastDecision[],
) {
  const key = await pastKey($)
  const write = storing.then(async () => {
    const stored = await $.store.get(key)
    await $.store.set(key, change(Array.isArray(stored) ? (stored as PastDecision[]) : []))
  })
  storing = write.catch(() => undefined)
  await write
}

// Over KEEP, the oldest non-decision entries go first: decisions stay.
function trim(list: Entry[]) {
  let extra = list.length - KEEP
  if (extra <= 0) return list

  return list.filter(one => {
    if (one.kind === 'decision' || extra === 0) return true
    extra -= 1

    return false
  })
}

async function openTurn($: EngineInterface, text: string) {
  await update($, turn, n => n + 1)
  await add($, { kind: 'ask', by: 'user', text: clip(text, 300) })
}

async function add($: EngineInterface, entry: Omit<Entry, 'id' | 'at' | 'turn'>) {
  const full: Entry = {
    ...entry,
    id: crypto.randomUUID(),
    at: await $.clock.now(),
    turn: await read($, turn),
  }
  await update($, entries, list => trim([...list, full]))
  await refreshStatus($)

  return full
}

async function patch($: EngineInterface, id: string, change: Partial<Entry>) {
  await update($, entries, list =>
    list.map(one => (one.id === id ? { ...one, ...change } : one)),
  )
}

async function addEdit($: EngineInterface, path: string, isSubagent: boolean) {
  const at = await $.clock.now()
  const n = await read($, turn)
  const id = crypto.randomUUID()
  const text = await shortPath($, path)
  await update($, entries, list => {
    const i = list.findIndex(one => one.kind === 'edit' && one.turn === n && one.text === text)
    if (i >= 0) {
      return list.map((one, j) => (j === i ? { ...one, at, count: (one.count ?? 1) + 1 } : one))
    }
    const entry: Entry = { id, at, turn: n, kind: 'edit', by: 'claude', text, isSubagent }

    return trim([...list, entry])
  })
  await refreshStatus($)
}

// The standing decisions, this session's and earlier ones', that `query`
// names best: none, one text (recorded once or more), or several texts
// named equally well.
async function named($: EngineInterface, query: string) {
  const session = await $.session.id()
  const own = (await read($, entries)).filter(
    one => one.kind === 'decision' && one.replacedBy === undefined,
  )
  const earlier = (await read($, past)).filter(
    one => one.session !== session && one.replacedBy === undefined,
  )
  const scored = [...earlier, ...own]
    .map(one => ({ id: 'turn' in one ? one.id : undefined, at: one.at, text: one.text, score: rank(one.text, query) }))
    .filter(one => one.score > 0)
  const best = Math.max(0, ...scored.map(one => one.score))

  return scored.filter(one => one.score === best)
}

async function markReplaced(
  $: EngineInterface,
  chosen: ReadonlyArray<{ id?: string; at: number; text: string }>,
  by: string,
) {
  for (const one of chosen) {
    if (one.id !== undefined) await patch($, one.id, { replacedBy: by })
  }
  const mark = (one: PastDecision) =>
    chosen.some(c => c.at === one.at && c.text === one.text) ? { ...one, replacedBy: by } : one
  await update($, past, list => list.map(mark))
  await changeStored($, list => list.map(mark)).catch(() => undefined)
}

async function logDecision($: EngineInterface, decision: Decision) {
  const entry = await add($, { kind: 'decision', ...decision })
  const kept: PastDecision = {
    id: entry.id,
    session: await $.session.id(),
    at: entry.at,
    by: decision.by,
    text: decision.text,
    why: decision.why,
  }
  // Best effort: the pane already holds the decision, so a failed write
  // must not read as a failed log.
  await changeStored($, list => [...list, kept].slice(-PAST_KEEP)).catch(() => undefined)
}

async function loadPast($: EngineInterface) {
  const stored = await $.store.get(await pastKey($))
  await update($, past, () => (Array.isArray(stored) ? (stored as PastDecision[]) : []))
}

async function resetSession($: EngineInterface) {
  pendingCommand = undefined
  await update($, entries, () => [])
  await update($, turn, () => 0)
  await update($, live, () => ({ startedAt: null, now: 0, inflight: [] }))
  await update($, folds, () => ({}))
  await update($, search, () => '')
  await refreshStatus($)
}

async function refreshStatus($: EngineInterface) {
  const list = await read($, entries)
  const decisions = list.filter(one => one.kind === 'decision').length
  const files = new Set(list.filter(one => one.kind === 'edit').map(one => one.text)).size
  $.ui.status(
    decisions + files === 0 ? undefined : `${decisions} decisions · ${files} files`,
  )
}

async function tick($: EngineInterface) {
  const state = await read($, live)
  if (state.startedAt === null) return
  const now = await $.clock.now()
  await update($, live, l => ({ ...l, now }))
}

async function describeCall($: EngineInterface, e: ToolCallInput) {
  const args = e as unknown as Record<string, unknown>
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  const tool = String(e.tool)
  switch (tool) {
    case 'Read':
      return `Reading ${await shortPath($, str('file_path'))}`
    case 'Edit':
    case 'Write':
      return `Editing ${await shortPath($, str('file_path'))}`
    case 'NotebookEdit':
      return `Editing ${await shortPath($, str('notebook_path'))}`
    case 'Bash':
      return str('description') !== '' ? str('description') : str('command')
    case 'Grep':
    case 'Glob':
      return `Searching ${str('pattern')}`
    case 'Agent':
      return `Agent: ${str('description')}`
    case 'WebSearch':
      return `Searching the web: ${str('query')}`
    case 'WebFetch':
      return `Fetching ${str('url')}`
    case 'Skill':
      return `Skill ${str('skill')}`
    case 'AskUserQuestion':
      return 'Waiting for your answer'
    case 'ExitPlanMode':
      return 'Waiting for your plan approval'
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)

  return mcp !== null ? `${mcp[1]}: ${mcp[2]}` : tool
}

async function remembered($: EngineInterface) {
  const session = await $.session.id()
  const standing = (await read($, past))
    .filter(one => one.session !== session && one.replacedBy === undefined)
    .slice(-REMEMBERED)
  if (standing.length === 0) return undefined
  const lines = standing.map(one => {
    const who = one.by === 'user' ? 'the person' : 'Claude'
    const why = one.why !== undefined ? ` — ${one.why}` : ''

    return `- [${clock(one.at, true)}] ${one.text} (${who})${why}`
  })

  return [
    '# Decisions already made in this project',
    'Recorded in earlier sessions, oldest first. Treat them as settled unless the person says otherwise.',
    ...lines,
  ].join('\n')
}

async function setFold($: EngineInterface, n: number, isOpen: boolean) {
  await update($, folds, all => ({ ...all, [String(n)]: isOpen }))
}

async function mention($: EngineInterface, path: string) {
  await $.prompt.fill({ text: `@${path} `, mode: 'insert' })
}

async function revisit($: EngineInterface, text: string) {
  await $.prompt.fill({ text: `Revisit "${text}": `, mode: 'insert' })
}

// Sample data for a look at the pane: this session's state only, never the
// stored decisions.
async function seedDemo($: EngineInterface) {
  const now = await $.clock.now()
  const min = 60 * 1000
  let n = 0
  const entry = (turn: number, ago: number, rest: Omit<Entry, 'id' | 'turn' | 'at'>): Entry => ({
    ...rest,
    id: `demo-${(n += 1)}`,
    turn,
    at: now - ago * min,
  })
  await update($, entries, () => [
    entry(1, 42, { kind: 'ask', by: 'user', text: 'Add login with magic links to the dashboard', durationMs: 412000 }),
    entry(1, 41, { kind: 'decision', by: 'claude', text: 'Magic links over OAuth for v1', why: 'No provider setup, and the users are internal.', alternatives: 'Google OAuth, passwords' }),
    entry(1, 40, { kind: 'agent', by: 'claude', text: 'Explore: map the current auth flow' }),
    entry(1, 38, { kind: 'decision', by: 'claude', text: 'Store sessions in Postgres', why: 'The app already runs one.', replacedBy: 'Store sessions in Redis with a 7-day TTL' }),
    entry(1, 37, { kind: 'edit', by: 'claude', text: 'src/auth/magic-link.ts', count: 4 }),
    entry(1, 36, { kind: 'edit', by: 'claude', text: 'src/routes/login.tsx', count: 2 }),
    entry(1, 35, { kind: 'run', by: 'claude', text: 'Run the auth tests', isError: true }),
    entry(1, 35, { kind: 'run', by: 'claude', text: 'Run the auth tests' }),
    entry(2, 30, { kind: 'ask', by: 'user', text: 'Use Redis for sessions, we already pay for it', durationMs: 95000 }),
    entry(2, 30, { kind: 'decision', by: 'user', text: 'Store sessions in Redis with a 7-day TTL', why: 'Already paid for, and expiry is built in.' }),
    entry(2, 29, { kind: 'edit', by: 'claude', text: 'src/auth/session-store.ts', count: 3 }),
    entry(2, 28, { kind: 'run', by: 'claude', text: 'Install ioredis' }),
    entry(3, 12, { kind: 'ask', by: 'user', text: '/review src/auth', durationMs: 61000, isAborted: true }),
    entry(3, 12, { kind: 'skill', by: 'claude', text: 'code-review' }),
    entry(4, 2, { kind: 'ask', by: 'user', text: 'Rate-limit the magic link endpoint and email me a summary' }),
    entry(4, 2, { kind: 'decision', by: 'user', text: 'Email: Summary only', why: 'How much detail should the email have?' }),
    entry(4, 1, { kind: 'decision', by: 'claude', text: '5 requests per minute per email address', why: 'Stops abuse without hurting retries.', alternatives: 'per IP' }),
    entry(4, 1, { kind: 'edit', by: 'claude', text: 'src/routes/login.tsx', count: 1 }),
  ])
  await update($, turn, () => 4)
  await update($, live, () => ({
    startedAt: now - 72000,
    now,
    inflight: [
      { id: 'demo-a', label: 'Agent: check the rate limiter', at: now - 30000, agentId: 'demo-agent' },
      { id: 'demo-b', label: 'Editing src/middleware/rate-limit.ts', at: now - 2000 },
    ],
  }))
  await refreshStatus($)
}

async function exportTrail($: EngineInterface) {
  const list = await read($, entries)
  const now = await $.clock.now()
  const path = `.claude/trail/${stamp(now)}.md`
  const lines = [`# Trail ${stamp(now)}`, '']
  for (const [n, items] of groupByTurn(list)) {
    const ask = items.find(one => one.kind === 'ask')
    const took = ask?.durationMs !== undefined ? ` · ${duration(ask.durationMs)}` : ''
    lines.push(`## ${n === 0 ? 'Before the first ask' : `Turn ${n}`} · ${clock(items[0]!.at)}${took}`, '')
    if (ask !== undefined) lines.push(`> ${ask.text}`, '')
    for (const one of items) {
      if (one.kind !== 'ask') lines.push(`- ${markdownRow(one)}`)
    }
    lines.push('')
  }
  await $.fs.write(path, lines.join('\n'))

  return path
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'decide',
      description:
        "Log a decision to the person's trail pane: a choice you made, or one the person made or confirmed. See the Decision trail section of your instructions.",
      inputSchema: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            description: 'The choice itself, under 80 characters ("SQLite over Postgres for the cache").',
          },
          why: { type: 'string', description: 'One short sentence: the reason.' },
          alternatives: {
            type: 'string',
            description: 'What was considered and passed over, comma-separated. Optional.',
          },
          by: {
            type: 'string',
            enum: ['claude', 'user'],
            description: '"claude" for your own call, "user" when the person made or confirmed it.',
          },
          replaces: {
            type: 'string',
            description: "The earlier decision's text, when this one changes it. Optional.",
          },
        },
        required: ['what', 'why', 'by'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'trail',
      description: 'Open the decision trail pane (or: export, clear, forget)',
      argumentHint: '[export|clear|forget]',
    })
    await $.command.register({
      name: 'decide',
      description: 'Log a decision of yours to the trail',
      argumentHint: '<what> [because <why>]',
    })
    await loadPast($)
    await refreshStatus($)
    // A reload leaves no hook to pop the calls it caught in flight.
    await update($, live, l => ({ ...l, inflight: [] }))
    $.clock.every(1000, () => {
      void tick($)
    })
    void $.ui.open({ id: PANE, title: 'Trail' })

    return next(e)
  })

  // /clear raises no session.start: the conversation before it becomes an
  // earlier session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetSession($)
      await loadPast($)
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed
    const memory = await remembered($)

    return {
      sections: [
        ...composed.sections,
        { id: 'trail:guide', text: GUIDE, scope: 'session' },
        ...(memory !== undefined ? [{ id: 'trail:earlier', text: memory, scope: 'session' as const }] : []),
      ],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta === true) return next(e)
    if (e.command !== undefined) {
      pendingCommand = OWN_COMMANDS.has(e.command.name)
        ? undefined
        : `/${e.command.name} ${e.command.args}`.trim()
    } else if (e.text.trim() !== '') {
      pendingCommand = undefined
      await openTurn($, e.text)
    } else if ((e.attachments?.length ?? 0) > 0) {
      pendingCommand = undefined
      await openTurn($, '[attachment]')
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (pendingCommand !== undefined) {
        const line = pendingCommand
        pendingCommand = undefined
        await openTurn($, line)
      }
      const now = await $.clock.now()
      await update($, live, l => ({ ...l, startedAt: now, now }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Each loop clears only its own calls: a background agent's run on.
    await update($, live, l => ({
      ...l,
      inflight: l.inflight.filter(one => one.agentId !== e.agentId),
    }))
    if (e.agentId === undefined) {
      const n = await read($, turn)
      // Only an ask not timed yet: a turn with no ask of its own (a task
      // notification's) leaves the last one as it was.
      await update($, entries, list =>
        list.map(one =>
          one.kind === 'ask' && one.turn === n && one.durationMs === undefined
            ? { ...one, durationMs: e.durationMs, isAborted: e.isAborted }
            : one,
        ),
      )
      await update($, live, l => ({ ...l, startedAt: null, now: 0 }))
    }

    return next(e)
  })

  // What is running right now, for the pane's top line.
  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return next(e)
    const id = e.tool_use_id ?? crypto.randomUUID()
    const label = clip(await describeCall($, e), 120)
    const at = await $.clock.now()
    const agentId = e.agentId
    // A call nobody popped (its hook's environment was replaced) ages out.
    await update($, live, l => ({
      ...l,
      inflight: [...l.inflight.filter(one => at - one.at < STALE_MS), { id, label, at, agentId }].slice(-20),
    }))
    try {
      return await next(e)
    } finally {
      await update($, live, l => ({ ...l, inflight: l.inflight.filter(one => one.id !== id) }))
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const what = typeof e.what === 'string' ? clip(e.what, 160) : ''
    if (what === '') return { result: 'Not logged: `what` is empty.' }
    const query = typeof e.replaces === 'string' ? e.replaces.trim() : ''
    const candidates = query !== '' ? await named($, query) : []
    const texts = [...new Set(candidates.map(one => one.text))]
    if (texts.length > 1) {
      return {
        result: `Not logged: "${query}" names several standing decisions (${texts.join('; ')}). Call again with replaces set to one of them exactly.`,
      }
    }
    const replaced = texts[0]
    if (replaced !== undefined) await markReplaced($, candidates, what)
    await logDecision($, {
      by: e.by === 'user' ? 'user' : 'claude',
      text: what,
      why: typeof e.why === 'string' && e.why.trim() !== '' ? clip(e.why, 300) : undefined,
      alternatives:
        typeof e.alternatives === 'string' && e.alternatives.trim() !== ''
          ? clip(e.alternatives, 160)
          : undefined,
      isSubagent: e.agentId !== undefined,
    })
    if (replaced !== undefined) return { result: `Logged: ${what} (replaces: ${replaced})` }
    if (query !== '') {
      return { result: `Logged: ${what}. No standing decision matched "${query}", so none was marked replaced.` }
    }

    return { result: `Logged: ${what}` }
  }).catch(() => ({ result: 'Not logged: the trail failed to record it.' }))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await addEdit($, e.file_path, e.agentId !== undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await addEdit($, e.file_path, e.agentId !== undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await addEdit($, e.notebook_path, e.agentId !== undefined)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isReadOnly !== true) {
      const text = e.description !== undefined && e.description !== '' ? e.description : e.command
      await add($, {
        kind: 'run',
        by: 'claude',
        text: clip(text, 160),
        isError: ran.deny !== undefined || ran.isError === true,
        isSubagent: e.agentId !== undefined,
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const entry = await add($, {
      kind: 'agent',
      by: 'claude',
      text: clip(`${e.subagent_type ?? 'agent'}: ${e.description}`, 160),
      isRunning: true,
      isSubagent: e.agentId !== undefined,
    })
    const ran = await next(e)
    await patch($, entry.id, {
      isRunning: false,
      isError: ran.deny !== undefined || ran.isError === true,
    })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      await add($, { kind: 'skill', by: 'claude', text: e.skill, isSubagent: e.agentId !== undefined })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    // An auto-resolved dialog (the person was away) carries no choice of theirs.
    if (ran.deny === undefined && ran.isError !== true && ran.result.afkTimeoutMs === undefined) {
      const answers = ran.result.answers as Record<string, unknown>
      for (const asked of ran.result.questions) {
        const answer = answers[asked.question]
        if (typeof answer === 'string' && answer.trim() !== '') {
          await logDecision($, {
            by: 'user',
            text: clip(`${asked.header}: ${answer}`, 160),
            why: clip(asked.question, 300),
          })
        }
      }
      const typed = ran.result.response?.trim() ?? ''
      if (typed !== '') {
        await logDecision($, { by: 'user', text: clip(typed, 160), why: 'Answered in their own words.' })
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    // A teammate's plan awaiting its leader is not approved yet.
    if (ran.deny === undefined && ran.isError !== true && ran.result.awaitingLeaderApproval !== true) {
      await logDecision($, { by: 'user', text: 'Approved the plan' })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'trail' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'export') {
      return { text: `Trail saved to ${await exportTrail($)}` }
    }
    if (arg === 'clear') {
      const session = await $.session.id()
      await resetSession($)
      await changeStored($, list => list.filter(one => one.session !== session))
      await loadPast($)

      return { text: 'Trail cleared for this session.' }
    }
    if (arg === 'demo') {
      if ((await read($, entries)).some(one => !one.id.startsWith('demo-'))) {
        return { text: 'This session already has a trail; run /trail demo in a fresh session.' }
      }
      await seedDemo($)
      await $.ui.open({ id: PANE, title: 'Trail' })

      return { text: 'Trail filled with sample data for this session. /trail clear empties it.' }
    }
    if (arg === 'forget') {
      await changeStored($, () => [])
      await update($, past, () => [])

      return { text: "Forgot this project's decisions from earlier sessions." }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Trail' })

    return { text: opened.isPlaced ? 'Trail pane open.' : `Trail pane waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'decide' }, async ($, e) => {
    const found = /^(.*?)\s+(?:because|--)\s+(.*)$/is.exec(e.args.trim())
    const what = clip(found?.[1] ?? e.args, 160)
    const why = found?.[2] !== undefined ? clip(found[2], 300) : undefined
    if (what === '') return { text: 'Usage: /decide <what> [because <why>]' }
    await logDecision($, { by: 'user', text: what, why })

    return {
      text: `Logged your decision: ${what}`,
      context: [
        `The person logged a decision in their trail: "${what}"${why !== undefined ? `, because ${why}` : ''}. Treat it as settled.`,
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // One cell of gutter on the left, so the rail does not touch the frame.
    const W = Math.max(24, e.props.bodyColumns - 1)
    const list = await read($, entries)
    const stored = await read($, view)
    const mode: View = stored === 'decisions' || stored === 'files' ? stored : 'timeline'
    const now = await read($, live)
    const opened = await read($, folds)
    const typed = await read($, search)
    // A surface with no field to edit the filter shows every decision.
    const canFilter = e.surface !== 'mobile' && 'Input' in $.ui.resolve(e)
    const query = canFilter ? typed.trim().toLowerCase() : ''
    // The store also holds this session's decisions, already shown above.
    const shown = new Set(
      list.filter(one => one.kind === 'decision').map(one => `${one.at}|${one.text}`),
    )
    const earlier = (await read($, past)).filter(one => !shown.has(`${one.at}|${one.text}`))

    const decisions = list.filter(one => one.kind === 'decision')
    const standing = decisions.filter(one => one.replacedBy === undefined)
    const files = filesChanged(list)
    const isWorking = now.startedAt !== null
    const today = await $.clock.now()

    // One rail row: the rail's glyphs in the turn's colour, then the body.
    const railRow = (rail: string, color: Color, body: RenderNode) => (
      <Box flexDirection="row">
        <Text color={color}>{rail}</Text>
        {body}
      </Box>
    )

    // ── The live block: what is happening right now.
    const liveBlock = () => {
      const waiting = now.inflight.find(one => one.label.startsWith('Waiting for your'))
      const running = [...now.inflight].reverse().slice(0, 3)
      const detail = running.map(one => (
        <Text wrap="truncate-end">
          {'  '}
          {one.label}
          {one.agentId !== undefined ? <Text dimColor> (subagent)</Text> : ''}
        </Text>
      ))
      if (waiting !== undefined) {
        return (
          <Box flexDirection="column">
            <Text>
              <Text inverse color="warning" bold>
                {' Needs you '}
              </Text>
              {' '}
              {waiting.label}
            </Text>
          </Box>
        )
      }
      if (isWorking || running.length > 0) {
        return (
          <Box flexDirection="column">
            {isWorking ? (
              <Text color="warning" bold>
                {'● Working '}
                <Text color="warning">{elapsed(now.now - (now.startedAt ?? now.now))}</Text>
              </Text>
            ) : (
              <Text color="permission" bold>
                ● Background
              </Text>
            )}
            {detail}
          </Box>
        )
      }
      const last = [...list].reverse().find(one => one.kind === 'ask' && one.durationMs !== undefined)

      return (
        <Text dimColor>
          {'○ Idle'}
          {last?.durationMs !== undefined ? `   last turn took ${duration(last.durationMs)}` : ''}
        </Text>
      )
    }

    // ── Tabs.
    const tab = (key: View, label: string, hotkey: string, count?: number) => {
      const isActive = mode === key

      return (
        <Button key={`tab-${key}`} plain hotkey={hotkey} onPress={() => update($, view, () => key)}>
          {isActive ? (
            <Text bold underline color="claude">
              {label}
            </Text>
          ) : (
            <Text>{label}</Text>
          )}
          {count !== undefined && count > 0 ? <Text dimColor> {count}</Text> : ''}
        </Button>
      )
    }

    // ── Timeline: each turn a run on the rail.
    const decisionLines = (one: Entry, first: string, rest: string, color: Color, width: number) => {
      const isReplaced = one.replacedBy !== undefined
      const who = one.by === 'user' ? 'you ' : ''
      const [head = '', ...more] = wrap(one.text, width - 2 - who.length)
      const mark = (
        <Text color={isReplaced ? 'inactive' : one.by === 'user' ? 'suggestion' : 'claude'} bold>
          {isReplaced ? '◇ ' : '◆ '}
          {who}
        </Text>
      )
      const rows: RenderNode[] = [
        railRow(
          first,
          color,
          <Button key={`decision-${one.id}`} plain onPress={() => revisit($, one.text)}>
            {mark}
            {isReplaced ? (
              <Text strikethrough dimColor>
                {head}
              </Text>
            ) : (
              head
            )}
          </Button>,
        ),
      ]
      const indent = ' '.repeat(2 + who.length)
      for (const line of more) {
        rows.push(railRow(rest, color, isReplaced ? <Text strikethrough dimColor>{indent + line}</Text> : indent + line))
      }
      const notes = isReplaced
        ? [`replaced by ${one.replacedBy ?? ''}`]
        : [one.why ?? '', one.alternatives !== undefined ? `passed over: ${one.alternatives}` : ''].filter(
            note => note !== '',
          )
      for (const note of notes) {
        for (const line of wrap(note, width - 2)) {
          rows.push(railRow(rest, color, <Text dimColor>{'  ' + line}</Text>))
        }
      }

      return rows
    }

    const changeLine = (one: Entry): RenderNode => {
      const sub = one.isSubagent === true ? <Text dimColor> (subagent)</Text> : ''
      switch (one.kind) {
        case 'edit':
          return (
            <Text wrap="truncate-middle">
              <Text color="diffAdded">{'~ '}</Text>
              {one.text}
              {one.count !== undefined ? <Text dimColor> ×{one.count}</Text> : ''}
              {sub}
            </Text>
          )
        case 'run':
          return one.isError === true ? (
            <Text wrap="truncate-end" color="error">
              {'✗ '}
              {one.text}
              {sub}
            </Text>
          ) : (
            <Text wrap="truncate-end" dimColor>
              {'$ '}
              {one.text}
              {sub}
            </Text>
          )
        case 'agent':
          return (
            <Text wrap="truncate-end">
              <Text color={one.isError === true ? 'error' : 'permission'}>{'→ '}</Text>
              {one.text}
              {one.isRunning === true ? <Text color="warning"> running</Text> : ''}
            </Text>
          )
        case 'skill':
          return (
            <Text wrap="truncate-end" dimColor>
              {'/ '}
              {one.text}
            </Text>
          )
        default:
          return ''
      }
    }

    const turnBlock = ([n, items]: [number, Entry[]], index: number) => {
      const ask = items.find(one => one.kind === 'ask')
      const isLive = index === 0 && isWorking
      const state = isLive ? 'working' : ask?.isAborted === true ? 'stopped' : 'done'
      const color: Color = state === 'working' ? 'warning' : state === 'stopped' ? 'error' : 'inactive'
      // What the person chose for this turn, else open for the newest few.
      const isOpen = opened[String(n)] ?? index < OPEN_TURNS
      const children = items.filter(one => one.kind !== 'ask')
      const changes = children.filter(one => one.kind !== 'decision')
      const visible = isOpen ? children : children.filter(one => one.kind === 'decision')
      const folded = !isOpen && changes.length > 0 ? `+ ${changes.length} change${changes.length === 1 ? '' : 's'}` : ''
      const outcome =
        state === 'working' ? (
          <Text color="warning"> working</Text>
        ) : state === 'stopped' ? (
          <Text color="error"> stopped{ask?.durationMs !== undefined ? ` after ${duration(ask.durationMs)}` : ''}</Text>
        ) : ask?.durationMs !== undefined ? (
          <Text dimColor> {duration(ask.durationMs)}</Text>
        ) : (
          ''
        )
      const title = ask?.text ?? (n === 0 ? 'Before the first ask' : `Turn ${n}`)
      const titleLines = wrap(clip(title, (W - 3) * 2), W - 3)
      const rows: RenderNode[] = [
        railRow(
          '┏ ',
          color,
          <Button key={`turn-${n}`} plain onPress={() => setFold($, n, !isOpen)}>
            <Text dimColor>
              {children.length > 0 ? (isOpen ? '▾ ' : '▸ ') : '  '}
              {clock(items[0]!.at)}
            </Text>
            {outcome}
          </Button>,
        ),
        ...titleLines.map(line => railRow('┃ ', color, <Text bold>{line}</Text>)),
      ]
      const tail = folded !== '' ? [...visible, null] : visible
      tail.forEach((one, i) => {
        const isLast = i === tail.length - 1
        const first = isLast ? '┗━ ' : '┣━ '
        const rest = isLast ? '   ' : '┃  '
        if (one === null) {
          rows.push(railRow(first, color, <Text dimColor>{folded}</Text>))
        } else if (one.kind === 'decision') {
          rows.push(...decisionLines(one, first, rest, color, W - 3))
        } else {
          rows.push(railRow(first, color, changeLine(one)))
        }
      })
      if (tail.length === 0) rows.push(railRow('┗ ', color, ''))

      return (
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
      )
    }

    const timeline = () => {
      const groups = [...groupByTurn(list)].reverse()
      if (groups.length === 0) {
        return (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Nothing yet. Ask for something, and each turn shows up here with its decisions and
              changes.
            </Text>
          </Box>
        )
      }

      return <Box flexDirection="column">{groups.map(turnBlock)}</Box>
    }

    // ── Decisions: the ledger.
    const hit = (text: string, why?: string) =>
      query === '' || text.toLowerCase().includes(query) || (why ?? '').toLowerCase().includes(query)

    // A ledger row: the decision, who made it and when on the right, then
    // its reasons beneath.
    const ledgerRow = (args: {
      key: string
      text: string
      by: 'user' | 'claude'
      at: number
      isReplaced: boolean
      notes: string[]
      isCompact?: boolean
    }) => {
      const who = args.by === 'user' ? 'you' : 'Claude'
      const meta = `${who} ${when(args.at, today)}`
      const [head = '', ...more] = wrap(args.text, W - 3 - meta.length)
      const styled = (text: string) =>
        args.isReplaced ? (
          <Text strikethrough dimColor>
            {text}
          </Text>
        ) : (
          text
        )

      return (
        <Box flexDirection="column" marginTop={args.isCompact === true ? 0 : 1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key={args.key} plain onPress={() => revisit($, args.text)}>
              <Text
                color={args.isReplaced ? 'inactive' : args.by === 'user' ? 'suggestion' : 'claude'}
                bold
              >
                {args.isReplaced ? '◇ ' : '◆ '}
              </Text>
              {styled(head)}
            </Button>
            <Text>
              {' '}
              <Text color={args.by === 'user' ? 'suggestion' : 'claude'}>{who}</Text>
              <Text dimColor> {when(args.at, today)}</Text>
            </Text>
          </Box>
          {more.map(line => (
            <Text>
              {'  '}
              {styled(line)}
            </Text>
          ))}
          {args.notes
            .flatMap(note => wrap(note, W - 2))
            .map(line => (
              <Text dimColor>
                {'  '}
                {line}
              </Text>
            ))}
        </Box>
      )
    }

    const ledgerEntry = (one: Entry) =>
      ledgerRow({
        key: `ledger-${one.id}`,
        text: one.text,
        by: one.by,
        at: one.at,
        isReplaced: one.replacedBy !== undefined,
        notes:
          one.replacedBy !== undefined
            ? [`replaced by ${one.replacedBy}`]
            : [one.why ?? '', one.alternatives !== undefined ? `passed over: ${one.alternatives}` : ''].filter(
                note => note !== '',
              ),
      })

    const section = (title: string, count: number) => (
      <Box marginTop={1}>
        <Text bold>
          {title}
          <Text dimColor> {count}</Text>
        </Text>
      </Box>
    )

    const ledger = () => {
      const ui = $.ui.resolve(e)
      const field =
        canFilter && 'Input' in ui ? (
          <ui.Input
            key="decision-filter"
            label="Filter"
            placeholder="words in a decision or its reason"
            value={typed}
            onInput={value => update($, search, () => value)}
            onSubmit={value => update($, search, () => value)}
          />
        ) : (
          ''
        )
      const mine = [...standing].reverse().filter(one => hit(one.text, one.why))
      const replaced = [...decisions]
        .reverse()
        .filter(one => one.replacedBy !== undefined && hit(one.text, one.why))
      const before = [...earlier]
        .reverse()
        .filter(one => hit(one.text, one.why))
        .slice(0, PAST_SHOWN)

      if (decisions.length === 0 && earlier.length === 0) {
        return (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              No decisions yet. Claude logs its own as it makes them; log yours with /decide.
            </Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Box marginTop={1}>{field}</Box>
          {mine.length > 0 ? section('Standing', mine.length) : ''}
          {mine.map(ledgerEntry)}
          {replaced.length > 0 ? section('Replaced', replaced.length) : ''}
          {replaced.map(ledgerEntry)}
          {before.length > 0 ? section('From earlier sessions', before.length) : ''}
          {before.map((one, i) =>
            ledgerRow({
              key: `earlier-${one.id ?? `${one.at}-${i}`}`,
              text: one.text,
              by: one.by,
              at: one.at,
              isReplaced: one.replacedBy !== undefined,
              notes: one.replacedBy !== undefined ? [`replaced by ${one.replacedBy}`] : [],
              isCompact: i > 0,
            }),
          )}
          {query !== '' && mine.length + replaced.length + before.length === 0 ? (
            <Box marginTop={1}>
              <Text dimColor>No decision mentions "{query}".</Text>
            </Box>
          ) : (
            ''
          )}
        </Box>
      )
    }

    // ── Files: what changed, and the commands that changed it.
    const filesView = () => {
      const runs = list.filter(one => one.kind === 'run')
      if (files.length === 0 && runs.length === 0) {
        return (
          <Box marginTop={1}>
            <Text dimColor>No files changed yet.</Text>
          </Box>
        )
      }
      const most = Math.max(1, ...files.map(one => one.count))
      const barRoom = Math.min(10, Math.max(3, Math.floor(W / 6)))
      const longest = Math.max(...files.map(one => cells(one.path)), 4)
      const dateRoom = Math.max(...files.map(one => when(one.at, today).length))
      // path, space, bar, space, count (3), two spaces, date
      const pathRoom = Math.max(4, Math.min(longest, W - barRoom - 7 - dateRoom))

      return (
        <Box flexDirection="column">
          {files.length > 0 ? section('Files', files.length) : ''}
          {files.map(one => (
            <Button key={`file-${one.path}`} plain onPress={() => mention($, one.path)}>
              {padCells(clipMiddle(one.path, pathRoom), pathRoom)}
              <Text color="diffAdded">
                {' '}
                {'█'.repeat(Math.max(1, Math.round((one.count / most) * barRoom))).padEnd(barRoom)}
              </Text>
              <Text dimColor>
                {' '}
                {String(one.count).padStart(3)}
                {'  '}
                {when(one.at, today)}
              </Text>
            </Button>
          ))}
          {runs.length > 0 ? section('Commands', runs.length) : ''}
          {[...runs].reverse().map(one => changeLine(one))}
        </Box>
      )
    }

    const hint =
      mode === 'files'
        ? 'Click a file to mention it in your prompt.'
        : mode === 'decisions'
          ? 'Click a decision to push back on it.'
          : 'Click a turn to fold it, a decision to push back on it.'

    return (
      <Box flexDirection="column" paddingLeft={1}>
        {liveBlock()}
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Box flexDirection="row" gap={2}>
            {tab('timeline', 'Timeline', '1')}
            {tab('decisions', 'Decisions', '2', standing.length)}
            {tab('files', 'Files', '3', files.length)}
          </Box>
          <Button
            key="export"
            plain
            hotkey="e"
            onPress={async () => {
              $.ui.toast(`Trail saved to ${await exportTrail($)}`)
            }}
          >
            <Text dimColor>Export</Text>
          </Button>
        </Box>
        <Text color="inactive">{'─'.repeat(W)}</Text>
        {mode === 'timeline' ? timeline() : mode === 'decisions' ? ledger() : filesView()}
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {hint}
          </Text>
        </Box>
      </Box>
    )
  })
}

// How well `query` names a decision: 3 exactly, 2 a part of it, 1 the
// decision inside a query not much longer than it, 0 not at all.
function rank(text: string, query: string) {
  const a = text.toLowerCase().trim()
  const b = query.toLowerCase().trim()
  if (b === '') return 0
  if (a === b) return 3
  if (b.length >= 4 && a.includes(b)) return 2
  if (a.length >= 12 && a.length * 2 >= b.length && b.includes(a)) return 1

  return 0
}

// The cells a character takes on a terminal: two for wide scripts and emoji.
function cellsOf(char: string) {
  const c = char.codePointAt(0) ?? 0
  const isWide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)

  return isWide ? 2 : 1
}

function cells(text: string) {
  let n = 0
  for (const char of text) n += cellsOf(char)

  return n
}

// The longest head of `text` that fits in `room` cells, never splitting a character.
function fit(text: string, room: number) {
  let used = 0
  let head = ''
  for (const char of text) {
    used += cellsOf(char)
    if (used > room) break
    head += char
  }

  return head
}

// Words onto lines of at most `width` cells; a word longer than a line is cut.
function wrap(text: string, width: number) {
  const room = Math.max(8, width)
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line === '') line = word
    else if (cells(line) + 1 + cells(word) <= room) line = `${line} ${word}`
    else {
      lines.push(line)
      line = word
    }
    while (cells(line) > room) {
      const head = fit(line, room)
      lines.push(head)
      line = line.slice(head.length)
    }
  }
  if (line !== '') lines.push(line)

  return lines.length > 0 ? lines : ['']
}

function clipMiddle(text: string, max: number) {
  if (cells(text) <= max) return text
  const head = fit(text, Math.ceil((max - 1) / 2))
  const tailRoom = max - 1 - cells(head)
  const tail = [...text].reverse().join('')

  return `${head}…${[...fit(tail, tailRoom)].reverse().join('')}`
}

function padCells(text: string, room: number) {
  return text + ' '.repeat(Math.max(0, room - cells(text)))
}

// Each changed file once: its edits summed, newest first.
function filesChanged(list: readonly Entry[]) {
  const files = new Map<string, { path: string; count: number; at: number }>()
  for (const one of list) {
    if (one.kind !== 'edit') continue
    const seen = files.get(one.text)
    files.set(one.text, {
      path: one.text,
      count: (seen?.count ?? 0) + (one.count ?? 1),
      at: Math.max(seen?.at ?? 0, one.at),
    })
  }

  return [...files.values()].sort((a, b) => b.at - a.at)
}

function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim()

  const chars = [...line]

  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : line
}

function groupByTurn(list: readonly Entry[]) {
  const turns = new Map<number, Entry[]>()
  for (const one of list) turns.set(one.turn, [...(turns.get(one.turn) ?? []), one])

  return turns
}

function summary(items: readonly Entry[]) {
  const count = (kind: Entry['kind'], word: string) => {
    const n = items.filter(one => one.kind === kind).length

    return n === 0 ? '' : `${n} ${word}${n === 1 ? '' : 's'}`
  }

  return [count('edit', 'edit'), count('run', 'run'), count('agent', 'agent'), count('skill', 'skill')]
    .filter(part => part !== '')
    .join(' · ')
}

function markdownRow(one: Entry) {
  const sub = one.isSubagent === true ? ' _(subagent)_' : ''
  switch (one.kind) {
    case 'decision': {
      const who = one.by === 'user' ? 'You' : 'Claude'
      if (one.replacedBy !== undefined) {
        return `~~**${who} decided:** ${one.text}~~ (replaced by: ${one.replacedBy})${sub}`
      }
      const why = one.why !== undefined ? ` — ${one.why}` : ''
      const alt = one.alternatives !== undefined ? ` (passed over: ${one.alternatives})` : ''

      return `**${who} decided:** ${one.text}${why}${alt}${sub}`
    }
    case 'edit':
      return `Changed \`${one.text}\`${one.count !== undefined ? ` ×${one.count}` : ''}${sub}`
    case 'run':
      return `Ran: ${one.text}${one.isError === true ? ' (failed)' : ''}${sub}`
    case 'agent':
      return `Agent ${one.text}${one.isError === true ? ' (failed)' : ''}`
    case 'skill':
      return `Skill: ${one.text}`
    case 'ask':
      return `> ${one.text}`
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The time for today, else the day: 23:29, Oct 19.
function when(ms: number, today: number) {
  const d = new Date(ms)
  const t = new Date(today)
  const isToday =
    d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()

  return isToday ? clock(ms) : `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function clock(ms: number, withDate = false) {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`

  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time
}

function stamp(ms: number) {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

// A running clock: 0:42, 12:05, 1:02:05.
function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)

  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

// A finished length: 12s, 4m 05s, 1h 02m.
function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`

  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}
