import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderNode, ToolCallInput } from 'claude-code'

import type { Entry, Handoff, PastDecision, SharedDecision, TeamMark, View } from '../types'

const PANE = 'trail'
const TOOL = 'mcp__trail__decide'
const KEEP = 500
const PAST_KEEP = 200
const PAST_SHOWN = 15
const REMEMBERED = 20
// The team's decisions, in the project and under git.
const SHARED_FILE = '.claude/decisions.md'
const SHARED_SHOWN = 50
// How many standing decisions a new one is checked against.
const CHECKED = 60
// Logged for the session's record, never kept for later or shared.
const PLAN = 'Approved the plan'
// The newest turns start unfolded; a click flips any turn.
const OPEN_TURNS = 2
const STALE_MS = 30 * 60 * 1000
// How often the team file is looked at for a pull's changes.
const TEAM_POLL_MS = 5000
// How many team decisions that arrive at once are checked for contradictions.
const ARRIVALS_CHECKED = 10
// A command that may have made a commit; HEAD moving is what tells.
const COMMIT = /\bgit\b[^;&|\n]*\bcommit\b/
// How much of a commit's changes the drift check reads, lockfiles left out.
const DIFF_CHARS = 24000
const LOCKS = [':(exclude)*package-lock.json', ':(exclude)*pnpm-lock.yaml', ':(exclude)*.lock', ':(exclude)*go.sum']
const HANDOFF_FILES = 5

const entries = atom({ plugin: 'trail', key: 'entries' } as const, [])
const view = atom({ plugin: 'trail', key: 'view' } as const, 'timeline')
const folds = atom({ plugin: 'trail', key: 'folds' } as const, {})
const search = atom({ plugin: 'trail', key: 'search' } as const, '')
const turn = atom({ plugin: 'trail', key: 'turn' } as const, 0)
const past = atom({ plugin: 'trail', key: 'past' } as const, [])
const shared = atom({ plugin: 'trail', key: 'shared' } as const, [])
const live = atom({ plugin: 'trail', key: 'live' } as const, {
  startedAt: null,
  now: 0,
  inflight: [],
})
const handoff = atom({ plugin: 'trail', key: 'handoff' } as const, null)
const forClaude = atom({ plugin: 'trail', key: 'notes' } as const, [])

const GUIDE = `# Decision trail
The person follows this session in a trail pane: their asks, the decisions made, and the changes. Keep its decisions complete with ${TOOL}:
- Call it when you settle a non-obvious choice: an approach, design, library, data shape, scope cut or tradeoff. Call it at the moment of choosing, before acting on it.
- Also call it with by: "user" when the person makes, states or overrides a choice in their message ("use Postgres", "skip tests for now"). Answers to AskUserQuestion and plan approvals are logged automatically; don't repeat them.
- When you act on something you assume but haven't checked with the person (what an API does, what they meant), call it with assumption: true. They confirm or reject it in the pane; carry on meanwhile.
- When a decision changes an earlier one (from this session, or listed under "Decisions already made in this project"), pass replaces with the earlier decision's text.
- Skip routine steps (reading files, running a build, fixing a typo). One call per decision, and no need to mention the logging in your reply.
- what: the choice itself, under 80 characters ("SQLite over Postgres for the cache"). why: one short sentence.`

const CHECK = `You compare a new decision with the decisions a software project has already settled.
Two decisions conflict when both cannot hold at once: following one means going against the other ("Postgres for sessions" and "Redis for sessions"; "No new dependencies" and "Add lodash").
Decisions about different things do not conflict, and neither does one that narrows, extends or applies another.
Answer with the number of the settled decision the new one conflicts with, or 0 when it conflicts with none. The number alone.`

const DRIFT = `You check a commit against the decisions a software project has settled.
A commit goes against a decision when it does what the decision rules out: it uses what the decision passed over, puts something where the decision placed it elsewhere, or undoes it.
A commit that carries a decision out, extends it or changes other things does not go against it. When unsure, it does not.
Answer with the number of the decision the commit goes against, or 0 when it goes against none. The number alone.`

const HANDOFF_ASK = `This message is from the trail plugin, not the person; leave any other message or notice above it aside. Write a handoff note for whoever picks this work up in a new session, who won't see this conversation: what got done, what is unfinished, the next step, and any question still waiting on the person. Answer with the note alone: at most five lines of plain text, each one short sentence, no headings, no preamble.`

const SHARED_HEADER = `# Decisions

What this project has settled, one per line. Claude reads this list at the start of every session through [Trail](https://github.com/m3talen/claude-trail), and \`/trail share\` adds a session's decisions. Edit it like any other file.`

type Decision = {
  by: 'user' | 'claude'
  text: string
  why?: string
  alternatives?: string
  isSubagent?: boolean
  replaces?: string
}

// A decision still in force, whoever made it and wherever it is kept.
type Standing = {
  text: string
  why?: string
  who: 'user' | 'claude' | 'team'
}

// The trail's own commands, which answer without a model turn.
const OWN_COMMANDS = new Set(['trail', 'decide'])

// A slash command's line, held until it starts a model turn; one that never
// does (/help, /config) opens no group.
let pendingCommand: string | undefined

// Chains every read-modify-write of the stored decisions, so parallel
// decide calls all land.
let storing: Promise<unknown> = Promise.resolve()

// Chains every read-modify-write of the team file and what the store knows
// of it, so a poll and a share never cross.
let teaming: Promise<unknown> = Promise.resolve()

// The team file's modification time when the poll last looked.
let teamStamp: number | undefined

// `git config user.name`, asked once.
let ownName: Promise<string | undefined> | undefined

// The session the project's stored decisions and handoff were loaded for. A
// /clear goes on under a new id with no session.start; the tick notices.
let loadedFor: string | undefined

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

// Over KEEP, the oldest changes go first: decisions and assumptions stay.
function trim(list: Entry[]) {
  let extra = list.length - KEEP
  if (extra <= 0) return list

  return list.filter(one => {
    if (one.kind === 'decision' || one.kind === 'assumption' || extra === 0) return true
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

// The standing decisions, this session's, earlier ones' and the team's,
// that `query` names best: none, one text (recorded once or more), or
// several texts named equally well.
async function named($: EngineInterface, query: string) {
  const session = await $.session.id()
  const own = (await read($, entries)).filter(
    one => one.kind === 'decision' && one.replacedBy === undefined,
  )
  const earlier = (await read($, past)).filter(
    one => one.session !== session && one.replacedBy === undefined,
  )
  const team = (await read($, shared)).filter(one => one.replacedBy === undefined)
  const scored = [
    ...team.map(one => ({ id: undefined, at: 0, text: one.text })),
    ...earlier.map(one => ({ id: undefined, at: one.at, text: one.text })),
    ...own.map(one => ({ id: one.id, at: one.at, text: one.text })),
  ]
    .map(one => ({ ...one, score: rank(one.text, query) }))
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
  await update($, shared, list =>
    list.map(one => (chosen.some(c => same(c.text, one.text)) ? { ...one, replacedBy: by } : one)),
  )
  await changeStored($, list => list.map(mark)).catch(() => undefined)
}

async function logDecision($: EngineInterface, decision: Decision) {
  const { replaces, ...shown } = decision
  const entry = await add($, { kind: 'decision', ...shown })
  await keep($, entry, replaces)

  return entry
}

// Keeps a decision for the project's later sessions.
async function keep($: EngineInterface, entry: Entry, replaces?: string) {
  const kept: PastDecision = {
    id: entry.id,
    session: await $.session.id(),
    at: entry.at,
    by: entry.by,
    text: entry.text,
    why: entry.why,
    ...(replaces !== undefined ? { replaces } : {}),
  }
  // Best effort: the pane already holds the decision, so a failed write
  // must not read as a failed log.
  await changeStored($, list => [...list, kept].slice(-PAST_KEEP)).catch(() => undefined)
}

async function logAssumption($: EngineInterface, text: string, why: string | undefined, isSubagent: boolean) {
  const again = (await read($, entries)).find(
    one => one.kind === 'assumption' && one.status === undefined && same(one.text, text),
  )
  if (again !== undefined) return `Already logged: ${again.text}.`
  await add($, { kind: 'assumption', by: 'claude', text, why, isSubagent })

  return `Logged the assumption: ${text}. The person can confirm or reject it in the pane; carry on meanwhile.`
}

// The person's answer to an assumption: confirmed, it becomes their
// decision in place; rejected, their prompt is started on what holds instead.
async function answerAssumption($: EngineInterface, id: string, isConfirmed: boolean) {
  const one = (await read($, entries)).find(x => x.id === id && x.kind === 'assumption')
  if (one === undefined || one.status !== undefined) return
  if (!isConfirmed) {
    await patch($, id, { status: 'rejected' })
    await tell($, `The person rejected your assumption "${one.text}". Stop relying on it; if their message doesn't say what holds instead, ask.`)
    await $.prompt.fill({ text: `Not so: "${one.text}". `, mode: 'insert' })

    return
  }
  const confirmed: Entry = { ...one, kind: 'decision', by: 'user', status: 'confirmed' }
  await patch($, id, { kind: 'decision', by: 'user', status: 'confirmed' })
  await keep($, confirmed)
  const conflict = await checkConflict($, id, one.text, one.why)
  await tell(
    $,
    `The person confirmed your assumption "${one.text}"; it is now their decision.${
      conflict !== undefined ? ` It appears to contradict "${conflict.text}", ${whose(conflict)}; ask them which holds.` : ''
    }`,
  )
}

// A line for Claude, delivered with the person's next prompt.
async function tell($: EngineInterface, text: string) {
  await update($, forClaude, list => [...list, text].slice(-10))
}

// What happened in the pane since Claude last heard (answered assumptions,
// team decisions that arrived contradicting one), taken for delivery.
async function takeNotes($: EngineInterface) {
  const told = await read($, forClaude)
  if (told.length === 0) return undefined
  await update($, forClaude, () => [])

  return `From the trail pane:\n${told.map(one => `- ${one}`).join('\n')}`
}

async function isDemo($: EngineInterface) {
  return (await read($, entries)).some(one => one.id.startsWith('demo-'))
}

async function storedPast($: EngineInterface) {
  const stored = await $.store.get(await pastKey($))

  return Array.isArray(stored) ? (stored as PastDecision[]) : []
}

async function loadPast($: EngineInterface) {
  const stored = await storedPast($)
  await update($, past, () => stored)
}

async function sharedPath($: EngineInterface) {
  return `${await $.session.root()}/${SHARED_FILE}`
}

// The shared file's text, or '' while there is none.
async function readShared($: EngineInterface) {
  try {
    const text = await $.fs.read(await sharedPath($))

    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

// Runs `work` once every read-modify-write of the team file before it is done.
function teamTurn<T>(work: () => Promise<T>) {
  const run = teaming.then(work)
  teaming = run.catch(() => undefined)

  return run
}

async function teamKey($: EngineInterface) {
  return `team:${await $.session.cwd()}`
}

// What the store knows of the team file's decisions, by folded text; undefined
// before Trail first read the file in this project.
async function teamMarks($: EngineInterface) {
  const stored = await $.store.get(await teamKey($))

  return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, TeamMark>)
    : undefined
}

function myName($: EngineInterface) {
  ownName ??= gitName($)

  return ownName
}

// The shared file's decisions, each marked when a decision here replaced it
// since, when it arrived during this session, and what it contradicts. Read
// again before each prompt and when the file changes, so a pull shows.
async function loadShared($: EngineInterface) {
  return teamTurn(() => readTeam($))
}

async function readTeam($: EngineInterface) {
  // Sample data stands in for the file until the session is cleared.
  if (await isDemo($)) return
  const gone = replacements(await storedPast($))
  const parsed = parseShared(await readShared($))
  const known = await teamMarks($)
  const marks = { ...(known ?? {}) }
  const session = await $.session.id()
  const now = await $.clock.now()
  const name = await myName($)
  // News is a line someone else added since this person last looked: not
  // what was there when Trail first read the file, nor one signed by them.
  const arrived: SharedDecision[] = []
  for (const one of parsed) {
    const key = fold(one.text)
    if (marks[key] !== undefined) continue
    const isNews = known !== undefined && (name === undefined || one.who !== name) && !gone.has(key)
    marks[key] = { at: now, session: isNews ? session : '' }
    if (isNews) arrived.push(one)
  }
  const inFile = new Set(parsed.map(one => fold(one.text)))
  for (const key of Object.keys(marks)) {
    if (!inFile.has(key)) delete marks[key]
  }
  if (JSON.stringify(marks) !== JSON.stringify(known)) await $.store.set(await teamKey($), marks)
  const list = parsed.map(one => {
    const key = fold(one.text)
    const by = gone.get(key)
    const mark = marks[key]

    return {
      ...one,
      ...(by !== undefined ? { replacedBy: by } : {}),
      ...(mark?.conflictsWith !== undefined ? { conflictsWith: mark.conflictsWith } : {}),
      ...(mark !== undefined && mark.session !== '' && mark.session === session ? { isNew: true } : {}),
    }
  })
  const before = await read($, shared)
  if (JSON.stringify(before) !== JSON.stringify(list)) {
    await update($, shared, () => list)
    await refreshStatus($)
  }
  if (arrived.length > 0) {
    const from = [...new Set(arrived.map(one => one.who).filter(who => who !== undefined))]
    $.ui.toast(
      `${plural(arrived.length, 'new team decision')}${from.length > 0 ? ` from ${from.join(', ')}` : ''} in ${SHARED_FILE}`,
    )
    void checkArrivals($, arrived).catch(() => undefined)
  }
}

// Checks the team decisions that just arrived against the standing ones, and
// marks each with what it contradicts.
async function checkArrivals($: EngineInterface, arrived: readonly SharedDecision[]) {
  for (const one of arrived.slice(0, ARRIVALS_CHECKED)) {
    const conflict = await findConflict($, one.text, one.why).catch(() => undefined)
    if (conflict === undefined) continue
    const key = fold(one.text)
    await teamTurn(async () => {
      const marks = await teamMarks($)
      const mark = marks?.[key]
      if (marks === undefined || mark === undefined) return
      await $.store.set(await teamKey($), { ...marks, [key]: { ...mark, conflictsWith: conflict.text } })
    })
    await update($, shared, list =>
      list.map(x => (fold(x.text) === key ? { ...x, conflictsWith: conflict.text } : x)),
    )
    await refreshStatus($)
    const who = one.who !== undefined ? ` (${one.who})` : ''
    await tell(
      $,
      `A team decision that just arrived in ${SHARED_FILE}, "${one.text}"${who}, appears to contradict "${conflict.text}", ${whose(conflict)}. Raise it with the person when it bears on the work; once they choose, call ${TOOL} with the one that holds and replaces set to the other.`,
    )
    $.ui.toast(`New team decision "${clip(one.text, 60)}" contradicts "${clip(conflict.text, 60)}" (Decisions tab)`)
  }
}

// Reads the team file again when it changed on disk: a pull, a checkout.
async function pollTeam($: EngineInterface) {
  const stat = await $.fs.stat(await sharedPath($)).catch(() => undefined)
  const stamp = stat?.mtimeMs ?? 0
  if (stamp === teamStamp) return
  teamStamp = stamp
  await loadShared($).catch(() => undefined)
}

// Every decision still in force, each text once and newest last: the
// team's, then earlier sessions', then this session's.
async function standingDecisions($: EngineInterface, except: string) {
  const session = await $.session.id()
  const team: Standing[] = (await read($, shared))
    .filter(one => one.replacedBy === undefined)
    .map(one => ({ text: one.text, why: one.why, who: 'team' }))
  const earlier: Standing[] = (await read($, past))
    .filter(one => one.session !== session && one.replacedBy === undefined)
    .map(one => ({ text: one.text, why: one.why, who: one.by }))
  const own: Standing[] = (await read($, entries))
    .filter(one => one.kind === 'decision' && one.replacedBy === undefined)
    .map(one => ({ text: one.text, why: one.why, who: one.by }))
  const seen = new Set([fold(except), fold(PLAN)])
  const newestFirst: Standing[] = []
  for (const one of [...team, ...earlier, ...own].reverse()) {
    if (seen.has(fold(one.text))) continue
    seen.add(fold(one.text))
    newestFirst.push(one)
  }

  return newestFirst.slice(0, CHECKED).reverse()
}

// The standing decision a new one contradicts, by a small model's judgment,
// or undefined when none does or the check could not run.
async function findConflict($: EngineInterface, text: string, why: string | undefined) {
  const standing = await standingDecisions($, text)
  if (standing.length === 0) return undefined
  const line = (one: { text: string; why?: string }) =>
    `${one.text}${one.why !== undefined ? ` (${one.why})` : ''}`
  const reply = await $.model.complete({
    model: 'haiku',
    system: CHECK,
    prompt: `Settled decisions:\n${standing.map((one, i) => `${i + 1}. ${line(one)}`).join('\n')}\n\nNew decision: ${line({ text, why })}`,
    maxTokens: 16,
    effort: 'low',
    timeoutMs: 15000,
  })
  if (!reply.isAnswered) return undefined
  const n = Number(/\d+/.exec(reply.text)?.[0] ?? 0)

  return n >= 1 && n <= standing.length ? standing[n - 1] : undefined
}

// Checks a decision just logged, and marks it with what it contradicts.
async function checkConflict($: EngineInterface, id: string, text: string, why: string | undefined) {
  const conflict = await findConflict($, text, why).catch(() => undefined)
  if (conflict === undefined) return undefined
  await patch($, id, { conflictsWith: conflict.text })
  await changeStored($, list =>
    list.map(one => (one.id === id ? { ...one, conflictsWith: conflict.text } : one)),
  ).catch(() => undefined)
  await refreshStatus($)

  return conflict
}

function whose(one: Standing) {
  return one.who === 'team'
    ? `a team decision in ${SHARED_FILE}`
    : one.who === 'user'
      ? 'a decision the person made'
      : 'an earlier decision of yours'
}

// What Claude is told when a decision it logged contradicts a standing one.
function conflictNote(conflict: Standing, what: string) {
  return `It appears to contradict "${conflict.text}", ${whose(conflict)}. If it is meant to change that one, check with the person, then call ${TOOL} again with what "${what}" and replaces "${conflict.text}". If the two can both hold, carry on.`
}

// git's output, or undefined when it failed or is not there.
async function git($: EngineInterface, args: string[]) {
  try {
    const ran = await $.process.run(['git', ...args], { timeoutMs: 10000 })

    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

// The commit HEAD names, or '' with none (or no repository).
async function headCommit($: EngineInterface) {
  return (await git($, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() ?? ''
}

// The standing decision the commits from `before` to `after` go against, by
// a small model's reading of their messages and changes.
async function findDrift($: EngineInterface, before: string, after: string) {
  const standing = await standingDecisions($, '')
  if (standing.length === 0) return undefined
  const range = before !== '' ? `${before}..${after}` : after
  const message = (await git($, ['log', '--no-color', '--format=%B', range]))?.trim() ?? ''
  const changes =
    (before !== ''
      ? await git($, ['diff', '--no-color', '--no-ext-diff', '--stat', '--patch', before, after, '--', ...LOCKS])
      : await git($, ['show', '--no-color', '--no-ext-diff', '--stat', '--patch', '--format=', after, '--', ...LOCKS])) ?? ''
  if (message === '' && changes.trim() === '') return undefined
  const line = (one: Standing) => `${one.text}${one.why !== undefined ? ` (${one.why})` : ''}`
  const cut = changes.length > DIFF_CHARS ? `${changes.slice(0, DIFF_CHARS)}\n[…the rest left out]` : changes
  const reply = await $.model.complete({
    model: 'haiku',
    system: DRIFT,
    prompt: `Settled decisions:\n${standing.map((one, i) => `${i + 1}. ${line(one)}`).join('\n')}\n\nThe commit's message:\n${message}\n\nIts changes:\n${cut}`,
    maxTokens: 16,
    effort: 'low',
    timeoutMs: 20000,
  })
  if (!reply.isAnswered) return undefined
  const n = Number(/\d+/.exec(reply.text)?.[0] ?? 0)

  return n >= 1 && n <= standing.length ? standing[n - 1] : undefined
}

async function gitName($: EngineInterface) {
  try {
    const ran = await $.process.run(['git', 'config', 'user.name'], { timeoutMs: 5000 })
    const name = ran.stdout.trim()

    return ran.exitCode === 0 && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

// Writes the project's standing decisions into the shared file: the new
// ones appended, the replaced ones taken out, every other line as it was.
// Decisions in an open conflict wait until it is settled.
async function shareDecisions($: EngineInterface) {
  if (await isDemo($)) return { isDemo: true, added: 0, removed: 0, held: 0 }

  return teamTurn(() => writeShared($))
}

async function writeShared($: EngineInterface) {
  const before = await readShared($)
  const stored = await storedPast($)
  const gone = replacements(stored)
  for (const one of await read($, shared)) {
    if (one.replacedBy !== undefined) gone.set(fold(one.text), one.replacedBy)
  }
  const team = parseShared(before).map(one => {
    const by = gone.get(fold(one.text))

    return by !== undefined ? { ...one, replacedBy: by } : one
  })
  let removed = 0
  const kept = (before === '' ? SHARED_HEADER.split('\n') : before.replace(/\n+$/, '').split('\n')).filter(
    line => {
      const one = parseLine(line)
      if (one === undefined || !gone.has(fold(one.text))) return true
      removed += 1

      return false
    },
  )
  const plan = shareable(stored, team)
  const name = await gitName($)
  const added = plan.added.map(one => sharedLine(one, name))
  if (added.length > 0 || removed > 0) {
    // What a share writes is this person's own, never news to them.
    const marks = await teamMarks($)
    if (marks !== undefined) {
      const now = await $.clock.now()
      const own = Object.fromEntries(plan.added.map(one => [fold(one.text), { at: now, session: '' }]))
      await $.store.set(await teamKey($), { ...own, ...marks })
    }
    const gap = added.length > 0 && parseLine(kept[kept.length - 1] ?? '') === undefined ? [''] : []
    await $.fs.write(await sharedPath($), [...kept, ...gap, ...added].join('\n') + '\n')
    await readTeam($)
  }

  return { isDemo: false, added: added.length, removed, held: plan.held }
}

function shareMessage(shared: { isDemo: boolean; added: number; removed: number; held: number }) {
  if (shared.isDemo) return 'Sample data is never shared.'
  const held =
    shared.held > 0
      ? ` ${plural(shared.held, 'decision')} left out until ${shared.held === 1 ? 'its conflict is' : 'their conflicts are'} settled.`
      : ''
  if (shared.added + shared.removed === 0) return `Nothing new to share in ${SHARED_FILE}.${held}`
  const parts = [
    shared.added > 0 ? `added ${plural(shared.added, 'decision')}` : '',
    shared.removed > 0 ? `took out ${shared.removed} replaced` : '',
  ].filter(part => part !== '')

  return `${SHARED_FILE}: ${parts.join(', ')}. Commit it to share with your team.${held}`
}

async function resetSession($: EngineInterface) {
  pendingCommand = undefined
  await update($, entries, () => [])
  await update($, turn, () => 0)
  await update($, live, () => ({ startedAt: null, now: 0, inflight: [] }))
  await update($, folds, () => ({}))
  await update($, search, () => '')
  await update($, forClaude, () => [])
  await refreshStatus($)
}

// The line under the prompt, which Claude Code draws as a warning: kept for
// open conflicts alone, as the pane's tabs carry the counts.
async function refreshStatus($: EngineInterface) {
  const n = openConflicts(await read($, entries), await read($, past), await read($, shared)).size
  $.ui.status(
    n === 0
      ? undefined
      : n === 1
        ? '1 decision contradicts a standing one (Decisions tab)'
        : `${n} decisions contradict standing ones (Decisions tab)`,
  )
}

// Loads what the store keeps for this project into the session's state.
async function loadProject($: EngineInterface) {
  loadedFor = await $.session.id()
  await loadPast($)
  await loadShared($).catch(() => undefined)
  await loadHandoff($).catch(() => undefined)
  await refreshStatus($)
}

async function followSession($: EngineInterface) {
  if ((await $.session.id()) !== loadedFor) await loadProject($)
}

async function tick($: EngineInterface) {
  await followSession($)
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
  const team = (await read($, shared)).filter(one => one.replacedBy === undefined)
  const inTeam = new Set(team.map(one => fold(one.text)))
  const standing = (await read($, past))
    .filter(
      one =>
        one.session !== session &&
        one.replacedBy === undefined &&
        !same(one.text, PLAN) &&
        !inTeam.has(fold(one.text)),
    )
    .slice(-REMEMBERED)
  if (standing.length === 0 && team.length === 0) return undefined
  const parts = [
    '# Decisions already made in this project',
    'Treat them as settled unless the person says otherwise.',
  ]
  if (team.length > 0) {
    const shown = team.slice(-SHARED_SHOWN)
    parts.push('', `Shared with the team in ${SHARED_FILE}:`)
    for (const one of shown) {
      const why = one.why !== undefined ? ` — ${one.why}` : ''
      const meta = [one.who, one.on].filter(part => part !== undefined).join(', ')
      parts.push(`- ${one.text}${why}${meta !== '' ? ` (${meta})` : ''}`)
    }
    if (team.length > shown.length) {
      parts.push(`- …and ${team.length - shown.length} older ones in ${SHARED_FILE}.`)
    }
  }
  if (standing.length > 0) {
    parts.push('', "From the person's earlier sessions here, oldest first:")
    for (const one of standing) {
      const who = one.by === 'user' ? 'the person' : 'Claude'
      const why = one.why !== undefined ? ` — ${one.why}` : ''
      parts.push(`- [${clock(one.at, true)}] ${one.text} (${who})${why}`)
    }
  }

  return parts.join('\n')
}

// A turn's fold by its number; the last session's is 'last'.
async function setFold($: EngineInterface, n: number | 'last', isOpen: boolean) {
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
    entry(4, 1, { kind: 'decision', by: 'claude', text: '5 requests per minute per email, in app middleware', why: 'Stops abuse without hurting retries.', alternatives: 'per IP', conflictsWith: 'Rate limits live in the API gateway' }),
    entry(4, 1, { kind: 'assumption', by: 'claude', text: 'The summary email goes out through the existing mailer', why: 'src/mail already sends the invites.' }),
    entry(4, 1, { kind: 'edit', by: 'claude', text: 'src/routes/login.tsx', count: 1 }),
    entry(4, 0, { kind: 'run', by: 'claude', text: 'Commit the rate limiter', conflictsWith: 'Rate limits live in the API gateway' }),
  ])
  await update($, shared, () => [
    { text: 'pnpm, not npm', why: 'One lockfile across the monorepo.', who: 'Sam', on: '2026-09-28' },
    { text: 'Rate limits live in the API gateway', why: 'One place to tune them.', who: 'Sam', on: '2026-10-06' },
    { text: 'All timestamps stored in UTC', why: 'The servers span three regions.', who: 'Ada', on: '2026-10-14', isNew: true },
  ])
  await update($, handoff, () => ({
    session: 'demo',
    at: now - 26 * 60 * min,
    ask: 'Sketch the login page for the dashboard',
    askAt: now - 27 * 60 * min,
    durationMs: 184000,
    summary: 'Login form and route are in; no styling yet.',
    summaryAt: now - 26 * 60 * min,
    question: 'Should the login page sit under /admin, or at the root?',
    files: ['src/routes/login.tsx', 'src/styles/login.css'],
    fileCount: 2,
    failed: [],
    conflicts: [],
    assumptions: [],
  }))
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

async function handoffKey($: EngineInterface) {
  return `handoff:${await $.session.cwd()}`
}

function isHandoff(value: unknown): value is Handoff {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Handoff).session === 'string' &&
    typeof (value as Handoff).ask === 'string'
  )
}

// Rebuilds this session's handoff from its trail: where it stands now. A
// summary written on /trail handoff is kept until another replaces it.
async function saveHandoff($: EngineInterface, change: { answer?: string; summary?: string } = {}) {
  const list = await read($, entries)
  const ask = [...list].reverse().find(one => one.kind === 'ask')
  if (ask === undefined || (await isDemo($))) return undefined
  const key = await handoffKey($)
  const session = await $.session.id()
  const stored = await $.store.get(key)
  const mine = isHandoff(stored) && stored.session === session ? stored : undefined
  const now = await $.clock.now()
  const files = filesChanged(list)
  const question = change.answer !== undefined ? closingQuestion(change.answer) : mine?.question
  const summary = change.summary ?? mine?.summary
  const summaryAt = change.summary !== undefined ? now : mine?.summaryAt
  const note: Handoff = {
    session,
    at: now,
    ask: ask.text,
    askAt: ask.at,
    ...(ask.durationMs !== undefined ? { durationMs: ask.durationMs } : {}),
    ...(ask.isAborted === true ? { isAborted: true } : {}),
    ...(question !== undefined ? { question } : {}),
    files: files.slice(0, HANDOFF_FILES).map(one => one.path),
    fileCount: files.length,
    failed: failedRuns(list),
    conflicts: conflictLines(list, await read($, past), await read($, shared)),
    assumptions: list.filter(one => one.kind === 'assumption' && one.status === undefined).map(one => one.text),
    ...(summary !== undefined ? { summary, summaryAt: summaryAt ?? now } : {}),
  }
  await $.store.set(key, note)

  return note
}

// The last session's handoff, as a session starts. On a reload the store
// holds this session's own by then, and the one shown stays.
async function loadHandoff($: EngineInterface) {
  const stored = await $.store.get(await handoffKey($))
  if (isHandoff(stored) && stored.session !== (await $.session.id())) {
    await update($, handoff, () => stored)
  }
}

// The last session's handoff as Claude reads it.
function handoffText(note: Handoff) {
  const took =
    note.durationMs !== undefined
      ? `, ${note.isAborted === true ? 'stopped after' : 'took'} ${duration(note.durationMs)}`
      : ''
  const lines = [
    '# Where the last session here left off',
    'The person sees this in the trail pane. Use it when they pick the work back up.',
    `- Last ask (${clock(note.askAt, true)}${took}): ${note.ask}`,
  ]
  if (note.summary !== undefined) {
    lines.push(`- Handoff note, as of ${clock(note.summaryAt ?? note.at, true)}:`)
    for (const line of note.summary.split('\n')) lines.push(`  ${line}`)
  }
  if (note.conflicts.length > 0) lines.push(`- Open conflicts: ${note.conflicts.join('; ')}`)
  if (note.assumptions.length > 0) {
    lines.push(`- Your assumptions the person never confirmed: ${note.assumptions.join('; ')}`)
  }
  if (note.failed.length > 0) lines.push(`- Failed and not run again: ${note.failed.join('; ')}`)
  if (note.fileCount > 0) lines.push(`- Files changed: ${filesLine(note)}`)
  if (note.question !== undefined) lines.push(`- Your last reply ended on a question: ${note.question}`)

  return lines.join('\n')
}

function filesLine(note: Handoff) {
  const more = note.fileCount - note.files.length

  return `${note.files.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

// The question a reply closed on: the last line asking one in its final
// paragraphs, as a reply often puts the options after it.
function closingQuestion(answer: string) {
  const lines = answer
    .trim()
    .split(/\n\s*\n/)
    .slice(-3)
    .flatMap(part => part.split('\n'))
    .map(line => line.trim())
  const asked = [...lines].reverse().find(line => line.endsWith('?'))

  return asked !== undefined ? clip(asked.replace(/^[-*•]\s+/, ''), 240) : undefined
}

// Commands whose last run failed, newest last.
function failedRuns(list: readonly Entry[]) {
  const last = new Map<string, boolean>()
  for (const one of list) {
    if (one.kind !== 'run') continue
    last.delete(one.text)
    last.set(one.text, one.isError === true)
  }

  return [...last]
    .filter(([, isError]) => isError)
    .map(([text]) => text)
    .slice(-3)
}

// Each open conflict as a line: the decision, then what it contradicts.
function conflictLines(list: readonly Entry[], stored: readonly PastDecision[], team: readonly SharedDecision[]) {
  const open = openConflicts(list, stored, team)

  return [
    ...list.filter(one => open.has(one.id)),
    ...team.filter(one => open.has(teamId(one))),
  ].map(one => `"${one.text}" contradicts "${one.conflictsWith ?? ''}"`)
}

async function pickUp($: EngineInterface) {
  await $.prompt.fill({ text: 'Pick up where the last session left off. ', mode: 'insert' })
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
          assumption: {
            type: 'boolean',
            description:
              'True for something you assume and act on without the person having confirmed it; they confirm or reject it in the pane. Optional.',
          },
        },
        required: ['what', 'why', 'by'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'trail',
      description: 'Open the decision trail pane (or: share, handoff, export, clear, forget)',
      argumentHint: '[share|handoff|export|clear|forget]',
    })
    await $.command.register({
      name: 'decide',
      description: 'Log a decision of yours to the trail',
      argumentHint: '<what> [because <why>]',
    })
    await loadProject($)
    // A reload leaves no hook to pop the calls it caught in flight.
    await update($, live, l => ({ ...l, inflight: [] }))
    $.clock.every(1000, () => {
      void tick($)
    })
    $.clock.every(TEAM_POLL_MS, () => {
      void pollTeam($)
    })
    void $.ui.open({ id: PANE, title: 'Trail' })

    return next(e)
  })

  // /clear raises no session.start: the conversation before it becomes an
  // earlier session, and its handoff the last session's.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetSession($)
      await loadPast($)
      await loadShared($).catch(() => undefined)
      const stored = await $.store.get(await handoffKey($))
      if (isHandoff(stored)) await update($, handoff, () => stored)
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed
    const memory = await remembered($)
    const last = await read($, handoff)

    return {
      sections: [
        ...composed.sections,
        { id: 'trail:guide', text: GUIDE, scope: 'session' },
        ...(memory !== undefined ? [{ id: 'trail:earlier', text: memory, scope: 'session' as const }] : []),
        ...(last !== null ? [{ id: 'trail:handoff', text: handoffText(last), scope: 'session' as const }] : []),
      ],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta === true) return next(e)
    await followSession($)
    await loadShared($).catch(() => undefined)
    if (e.command !== undefined) {
      pendingCommand = OWN_COMMANDS.has(e.command.name)
        ? undefined
        : `/${e.command.name} ${e.command.args}`.trim()

      return next(e)
    }
    if (e.text.trim() !== '') {
      pendingCommand = undefined
      await openTurn($, e.text)
    } else if ((e.attachments?.length ?? 0) > 0) {
      pendingCommand = undefined
      await openTurn($, '[attachment]')
    }
    const told = await takeNotes($)

    return next(told !== undefined ? { ...e, context: [...(e.context ?? []), told] } : e)
  })

  // A slash command that starts a model turn carries the pane's notes on its
  // expanded prompt; one that never does (/help) leaves them for the next.
  on('skill.prompt', async ($, e, next) => {
    const ran = await next(e)
    if (pendingCommand === undefined) return ran
    const told = await takeNotes($)

    return told !== undefined ? { text: `${ran.text}\n\n${told}` } : ran
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
      await saveHandoff($, { answer: e.answer }).catch(() => undefined)
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
    const why = typeof e.why === 'string' && e.why.trim() !== '' ? clip(e.why, 300) : undefined
    if (e.assumption === true) return { result: await logAssumption($, what, why, e.agentId !== undefined) }
    const query = typeof e.replaces === 'string' ? e.replaces.trim() : ''
    const candidates = query !== '' ? (await named($, query)).filter(one => !same(one.text, what)) : []
    const texts = [...new Set(candidates.map(one => one.text))]
    if (texts.length > 1) {
      return {
        result: `Not logged: "${query}" names several standing decisions (${texts.join('; ')}). Call again with replaces set to one of them exactly.`,
      }
    }
    const replaced = texts[0]
    const unmatched = query !== '' && replaced === undefined ? ` No standing decision matched "${query}", so none was marked replaced.` : ''
    // The same decision again is logged once; a replaces given now settles
    // the conflict flagged on it.
    const again = (await read($, entries)).find(
      one => one.kind === 'decision' && one.replacedBy === undefined && same(one.text, what),
    )
    if (again !== undefined) {
      if (replaced === undefined) return { result: `Already logged: ${again.text}.${unmatched}` }
      await markReplaced($, candidates, again.text)
      await patch($, again.id, { conflictsWith: undefined })
      await changeStored($, list =>
        list.map(one => (one.id === again.id ? { ...one, replaces: replaced, conflictsWith: undefined } : one)),
      ).catch(() => undefined)
      await refreshStatus($)

      return { result: `Logged: ${again.text} (replaces: ${replaced})` }
    }
    if (replaced !== undefined) await markReplaced($, candidates, what)
    const entry = await logDecision($, {
      by: e.by === 'user' ? 'user' : 'claude',
      text: what,
      why,
      alternatives:
        typeof e.alternatives === 'string' && e.alternatives.trim() !== ''
          ? clip(e.alternatives, 160)
          : undefined,
      isSubagent: e.agentId !== undefined,
      replaces: replaced,
    })
    if (replaced !== undefined) return { result: `Logged: ${what} (replaces: ${replaced})` }
    const conflict = await checkConflict($, entry.id, what, why)
    const note = conflict !== undefined ? ` ${conflictNote(conflict, what)}` : ''

    return { result: `Logged: ${what}${unmatched !== '' || note !== '' ? '.' : ''}${unmatched}${note}` }
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
    const before = COMMIT.test(e.command) ? await headCommit($) : undefined
    const ran = await next(e)
    if (ran.isReadOnly === true) return ran
    const text = e.description !== undefined && e.description !== '' ? e.description : e.command
    const isError = ran.deny !== undefined || ran.isError === true
    const entry = await add($, {
      kind: 'run',
      by: 'claude',
      text: clip(text, 160),
      isError,
      isSubagent: e.agentId !== undefined,
    })
    if (before === undefined || isError) return ran
    // A commit is checked as made: whatever HEAD moved over.
    const after = await headCommit($)
    if (after === '' || after === before) return ran
    const drift = await findDrift($, before, after).catch(() => undefined)
    if (drift === undefined) return ran
    await patch($, entry.id, { conflictsWith: drift.text })
    $.ui.toast(`This commit goes against "${clip(drift.text, 80)}" (Timeline)`)

    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `Trail: this commit appears to go against "${drift.text}", ${whose(drift)}. Say so in your reply. If the change is meant, check with the person and call ${TOOL} with the new decision and replaces "${drift.text}"; if not, put it right before going on.`,
      ],
    }
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
      await logDecision($, { by: 'user', text: PLAN })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'trail' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'export') {
      return { text: `Trail saved to ${await exportTrail($)}` }
    }
    if (arg === 'share') {
      return { text: shareMessage(await shareDecisions($)) }
    }
    if (arg === 'handoff') {
      if (await isDemo($)) return { text: 'Sample data gets no handoff.' }
      if (!(await read($, entries)).some(one => one.kind === 'ask')) {
        return { text: 'Nothing to hand off yet: this session has no asks.' }
      }
      const reply = await $.model.fork({ prompt: HANDOFF_ASK })
      if (!reply.isAnswered) return { text: `No handoff written: ${reply.reason}.` }
      const summary = reply.text
        .split('\n')
        .map(line => clip(line, 200))
        .filter(line => line !== '')
        .slice(0, 6)
        .join('\n')
      await saveHandoff($, { summary })

      return { text: `Handoff saved for the next session here:\n${summary}` }
    }
    if (arg === 'clear') {
      const session = await $.session.id()
      await resetSession($)
      await changeStored($, list => list.filter(one => one.session !== session))
      const key = await handoffKey($)
      const stored = await $.store.get(key)
      if (isHandoff(stored) && stored.session === session) await $.store.delete(key)
      if ((await read($, handoff))?.session === 'demo') await update($, handoff, () => null)
      await loadPast($)
      await loadShared($).catch(() => undefined)

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
      await loadShared($).catch(() => undefined)

      return {
        text: `Forgot this project's decisions from earlier sessions. The team's, in ${SHARED_FILE}, stay.`,
      }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Trail' })

    return { text: opened.isPlaced ? 'Trail pane open.' : `Trail pane waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'decide' }, async ($, e) => {
    const found = /^(.*?)\s+(?:because|--)\s+(.*)$/is.exec(e.args.trim())
    const what = clip(found?.[1] ?? e.args, 160)
    const why = found?.[2] !== undefined ? clip(found[2], 300) : undefined
    if (what === '') return { text: 'Usage: /decide <what> [because <why>]' }
    const entry = await logDecision($, { by: 'user', text: what, why })
    const conflict = await checkConflict($, entry.id, what, why)
    const logged = `The person logged a decision in their trail: "${what}"${why !== undefined ? `, because ${why}` : ''}. Treat it as settled.`
    if (conflict !== undefined) {
      return {
        text: `Logged your decision: ${what}. It looks like it contradicts "${conflict.text}".`,
        context: [
          `${logged} It appears to contradict the standing decision "${conflict.text}". Ask the person whether it replaces that one; if it does, call ${TOOL} with what "${what}", by "user" and replaces "${conflict.text}".`,
        ],
      }
    }

    return { text: `Logged your decision: ${what}`, context: [logged] }
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
    const team = await read($, shared)
    const inTeam = new Set(team.map(one => fold(one.text)))
    // The store also holds this session's decisions, already shown above,
    // and the shared file's, shown as the team's.
    const shown = new Set(
      list.filter(one => one.kind === 'decision').map(one => `${one.at}|${one.text}`),
    )
    const kept = await read($, past)
    const earlier = kept.filter(one => !shown.has(`${one.at}|${one.text}`) && !inTeam.has(fold(one.text)))

    const decisions = list.filter(one => one.kind === 'decision')
    const standing = decisions.filter(one => one.replacedBy === undefined)
    const conflicted = openConflicts(list, kept, team)
    const holding = inForce(list, kept, team)
    const unconfirmed = list.filter(one => one.kind === 'assumption' && one.status === undefined)
    const last = await read($, handoff)
    // What a share would change: decisions not in the file yet, and the
    // file's replaced ones to take out.
    const toShare =
      shareable([...kept, ...standing], team).added.length +
      team.filter(one => one.replacedBy !== undefined).length
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
    const tab = (key: View, label: string, hotkey: string, count?: number, alert?: number, asks?: number) => {
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
          {alert !== undefined && alert > 0 ? <Text color="warning"> ≠{alert}</Text> : ''}
          {asks !== undefined && asks > 0 ? <Text color="suggestion"> ?{asks}</Text> : ''}
        </Button>
      )
    }

    // The line under a decision that contradicts a standing one.
    const conflictText = (one: Entry) => `≠ conflicts with "${one.conflictsWith ?? ''}"`

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
      if (conflicted.has(one.id)) {
        for (const line of wrap(conflictText(one), width - 2)) {
          rows.push(railRow(rest, color, <Text color="warning">{'  ' + line}</Text>))
        }
      }
      const notes = isReplaced ? [`replaced by ${one.replacedBy ?? ''}`] : decisionNotes(one)
      for (const note of notes) {
        for (const line of wrap(note, width - 2)) {
          rows.push(railRow(rest, color, <Text dimColor>{'  ' + line}</Text>))
        }
      }

      return rows
    }

    // Confirm and reject, under an assumption still open.
    const answerButtons = (one: Entry) => (
      <Box flexDirection="row" gap={2}>
        <Button key={`confirm-${one.id}`} plain onPress={() => answerAssumption($, one.id, true)}>
          <Text color="success">{'  ✓ Confirm'}</Text>
        </Button>
        <Button key={`reject-${one.id}`} plain onPress={() => answerAssumption($, one.id, false)}>
          <Text color="error">✗ Reject</Text>
        </Button>
      </Box>
    )

    const assumptionLines = (one: Entry, first: string, rest: string, color: Color, width: number) => {
      const isRejected = one.status === 'rejected'
      const styled = (text: string) => (isRejected ? <Text strikethrough dimColor>{text}</Text> : text)
      const [head = '', ...more] = wrap(one.text, width - 2)
      const rows: RenderNode[] = [
        railRow(
          first,
          color,
          <Text>
            <Text color={isRejected ? 'inactive' : 'suggestion'} bold>
              {'? '}
            </Text>
            {styled(head)}
          </Text>,
        ),
        ...more.map(line => railRow(rest, color, <Text>{'  '}{styled(line)}</Text>)),
      ]
      const notes = isRejected ? ['you rejected it'] : [one.why ?? '', 'assumed, not confirmed'].filter(note => note !== '')
      for (const note of notes) {
        for (const line of wrap(note, width - 2)) {
          rows.push(railRow(rest, color, <Text dimColor>{'  ' + line}</Text>))
        }
      }
      if (!isRejected) rows.push(railRow(rest, color, answerButtons(one)))

      return rows
    }

    // The line under a commit that goes against a decision still in force.
    const driftLines = (one: Entry, width: number) =>
      one.kind === 'run' && one.conflictsWith !== undefined && holding.has(fold(one.conflictsWith))
        ? wrap(`≠ goes against "${one.conflictsWith}"`, width - 2).map(line => (
            <Text color="warning">
              {'  '}
              {line}
            </Text>
          ))
        : []

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
      // Decisions, and assumptions still waiting on an answer, show folded too.
      const isKept = (one: Entry) =>
        one.kind === 'decision' || (one.kind === 'assumption' && one.status === undefined)
      const changes = children.filter(one => !isKept(one))
      const visible = isOpen ? children : children.filter(isKept)
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
        } else if (one.kind === 'assumption') {
          rows.push(...assumptionLines(one, first, rest, color, W - 3))
        } else {
          rows.push(railRow(first, color, changeLine(one)))
          rows.push(...driftLines(one, W - 3).map(line => railRow(rest, color, line)))
        }
      })
      if (tail.length === 0) rows.push(railRow('┗ ', color, ''))

      return (
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
      )
    }

    // ── The last session's handoff, under this session's turns.
    const lastSession = (note: Handoff, hasTurns: boolean) => {
      const color: Color = 'inactive'
      const isOpen = opened.last ?? !hasTurns
      const width = W - 3
      const took =
        note.durationMs === undefined ? (
          ''
        ) : note.isAborted === true ? (
          <Text color="error"> stopped after {duration(note.durationMs)}</Text>
        ) : (
          <Text dimColor> {duration(note.durationMs)}</Text>
        )
      const items: Array<{ glyph: string; glyphColor: Color; text: string }> = [
        ...note.conflicts.map(text => ({ glyph: '≠ ', glyphColor: 'warning' as Color, text })),
        ...note.assumptions.map(text => ({ glyph: '? ', glyphColor: 'suggestion' as Color, text: `assumed, never confirmed: ${text}` })),
        ...note.failed.map(text => ({ glyph: '✗ ', glyphColor: 'error' as Color, text: `${text} failed` })),
        ...(note.fileCount > 0 ? [{ glyph: '~ ', glyphColor: 'diffAdded' as Color, text: filesLine(note) }] : []),
        ...(note.question !== undefined ? [{ glyph: '↳ ', glyphColor: 'claude' as Color, text: note.question }] : []),
      ]
      const rows: RenderNode[] = [
        railRow(
          '┏ ',
          color,
          <Button key="turn-last" plain onPress={() => setFold($, 'last', !isOpen)}>
            <Text dimColor>
              {isOpen ? '▾ ' : '▸ '}
              {when(note.askAt, today)} · last session
            </Text>
            {took}
          </Button>,
        ),
        ...wrap(clip(note.ask, width * 2), width).map(line => railRow('┃ ', color, <Text bold>{line}</Text>)),
      ]
      if (!isOpen) {
        rows.push(railRow('┗━ ', color, <Text dimColor>+ where it left off</Text>))
      } else {
        for (const line of (note.summary ?? '').split('\n').filter(one => one !== '')) {
          for (const part of wrap(line, width)) rows.push(railRow('┃ ', color, <Text dimColor>{part}</Text>))
        }
        for (const item of items) {
          const [head = '', ...more] = wrap(item.text, width - 2)
          rows.push(
            railRow(
              '┣━ ',
              color,
              <Text>
                <Text color={item.glyphColor}>{item.glyph}</Text>
                {head}
              </Text>,
            ),
          )
          for (const line of more) rows.push(railRow('┃  ', color, '  ' + line))
        }
        rows.push(
          railRow(
            '┗━ ',
            color,
            <Button key="pick-up" plain onPress={() => pickUp($)}>
              <Text color="claude">Pick up where it left off</Text>
            </Button>,
          ),
        )
      }

      return (
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
      )
    }

    const timeline = () => {
      const groups = [...groupByTurn(list)].reverse()
      const before = last !== null ? lastSession(last, groups.length > 0) : ''
      if (groups.length === 0) {
        return (
          <Box flexDirection="column">
            <Box marginTop={1}>
              <Text dimColor wrap="wrap">
                Nothing yet. Ask for something, and each turn shows up here with its decisions and
                changes.
              </Text>
            </Box>
            {before}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {groups.map(turnBlock)}
          {before}
        </Box>
      )
    }

    // ── Decisions: the ledger.
    const hit = (text: string, why?: string) =>
      query === '' || text.toLowerCase().includes(query) || (why ?? '').toLowerCase().includes(query)

    // A ledger row: the decision, who made it and when on the right, then
    // its reasons beneath.
    const ledgerRow = (args: {
      key: string
      text: string
      who: string
      whoColor: Color
      date: string
      isReplaced: boolean
      notes: string[]
      warning?: string
      isCompact?: boolean
      glyph?: string
      tag?: string
      footer?: RenderNode
    }) => {
      const tag = args.tag !== undefined ? `${args.tag} ` : ''
      const meta = `${tag}${args.who} ${args.date}`
      const [head = '', ...more] = wrap(args.text, W - 3 - cells(meta))
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
              <Text color={args.isReplaced ? 'inactive' : args.whoColor} bold>
                {args.glyph ?? (args.isReplaced ? '◇ ' : '◆ ')}
              </Text>
              {styled(head)}
            </Button>
            <Text>
              {' '}
              {tag !== '' ? <Text color="claude">{tag}</Text> : ''}
              <Text color={args.whoColor}>{args.who}</Text>
              {args.date !== '' ? <Text dimColor> {args.date}</Text> : ''}
            </Text>
          </Box>
          {more.map(line => (
            <Text>
              {'  '}
              {styled(line)}
            </Text>
          ))}
          {wrap(args.warning ?? '', W - 2)
            .filter(line => line !== '')
            .map(line => (
              <Text color="warning">
                {'  '}
                {line}
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
          {args.footer ?? ''}
        </Box>
      )
    }

    const ledgerEntry = (one: Entry) =>
      ledgerRow({
        key: `ledger-${one.id}`,
        text: one.text,
        who: one.by === 'user' ? 'you' : 'Claude',
        whoColor: one.by === 'user' ? 'suggestion' : 'claude',
        date: when(one.at, today),
        isReplaced: one.replacedBy !== undefined,
        warning: conflicted.has(one.id) ? conflictText(one) : undefined,
        notes: one.replacedBy !== undefined ? [`replaced by ${one.replacedBy}`] : decisionNotes(one),
      })

    const assumptionEntry = (one: Entry) =>
      ledgerRow({
        key: `assumed-${one.id}`,
        text: one.text,
        who: 'Claude',
        whoColor: 'suggestion',
        date: when(one.at, today),
        isReplaced: false,
        glyph: '? ',
        notes: one.why !== undefined ? [one.why] : [],
        footer: answerButtons(one),
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
      const ours = [...team].reverse().filter(one => hit(one.text, one.why))
      const assumed = [...unconfirmed].reverse().filter(one => hit(one.text, one.why))

      if (decisions.length === 0 && earlier.length === 0 && team.length === 0 && unconfirmed.length === 0) {
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
          {assumed.length > 0 ? section('Assumed, not confirmed', assumed.length) : ''}
          {assumed.map(assumptionEntry)}
          {mine.length > 0 ? section('Standing', mine.length) : ''}
          {mine.map(ledgerEntry)}
          {replaced.length > 0 ? section('Replaced', replaced.length) : ''}
          {replaced.map(ledgerEntry)}
          {ours.length > 0 ? section('Shared with the team', ours.length) : ''}
          {ours.map(one =>
            ledgerRow({
              key: `team-${fold(one.text)}`,
              text: one.text,
              who: one.who ?? 'team',
              whoColor: one.who === 'Claude' ? 'claude' : 'suggestion',
              date: one.on !== undefined ? day(one.on, today) : '',
              isReplaced: one.replacedBy !== undefined,
              tag: one.isNew === true && one.replacedBy === undefined ? 'new' : undefined,
              warning: conflicted.has(teamId(one)) ? `≠ conflicts with "${one.conflictsWith ?? ''}"` : undefined,
              notes:
                one.replacedBy !== undefined
                  ? [`replaced by ${one.replacedBy}; Share takes it out of ${SHARED_FILE}`]
                  : one.why !== undefined
                    ? [one.why]
                    : [],
            }),
          )}
          {before.length > 0 ? section('From earlier sessions', before.length) : ''}
          {before.map((one, i) =>
            ledgerRow({
              key: `earlier-${one.id ?? `${one.at}-${i}`}`,
              text: one.text,
              who: one.by === 'user' ? 'you' : 'Claude',
              whoColor: one.by === 'user' ? 'suggestion' : 'claude',
              date: when(one.at, today),
              isReplaced: one.replacedBy !== undefined,
              notes: one.replacedBy !== undefined ? [`replaced by ${one.replacedBy}`] : [],
              isCompact: i > 0,
            }),
          )}
          {query !== '' && assumed.length + mine.length + replaced.length + ours.length + before.length === 0 ? (
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
          {[...runs].reverse().flatMap(one => [changeLine(one), ...driftLines(one, W)])}
        </Box>
      )
    }

    const hint =
      mode === 'files'
        ? 'Click a file to mention it in your prompt.'
        : mode === 'decisions'
          ? `Click a decision to push back on it. Share puts them in ${SHARED_FILE}.`
          : 'Click a turn to fold it, a decision to push back on it.'

    return (
      <Box flexDirection="column" paddingLeft={1}>
        {liveBlock()}
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Box flexDirection="row" gap={2}>
            {tab('timeline', 'Timeline', '1')}
            {tab('decisions', 'Decisions', '2', standing.length, conflicted.size, unconfirmed.length)}
            {tab('files', 'Files', '3', files.length)}
          </Box>
          <Box flexDirection="row" gap={2}>
            <Button
              key="share"
              plain
              hotkey="s"
              onPress={async () => {
                $.ui.toast(shareMessage(await shareDecisions($)))
              }}
            >
              <Text dimColor>Share</Text>
              {toShare > 0 ? <Text color="claude"> {toShare}</Text> : ''}
            </Button>
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
  const a = fold(text)
  const b = fold(query)
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

// What shows under a standing decision: its reason, what it passed over, and
// whether it began as an assumption of Claude's.
function decisionNotes(one: Entry) {
  return [
    one.why ?? '',
    one.alternatives !== undefined ? `passed over: ${one.alternatives}` : '',
    one.status === 'confirmed' ? "you confirmed Claude's assumption" : '',
  ].filter(note => note !== '')
}

// A decision's text as compared: case and spacing aside.
function fold(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function same(a: string, b: string) {
  return fold(a) === fold(b)
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// Which decisions the stored ones replaced, by folded text, and by what.
function replacements(stored: readonly PastDecision[]) {
  const gone = new Map<string, string>()
  for (const one of stored) {
    if (one.replacedBy !== undefined) gone.set(fold(one.text), one.replacedBy)
    if (one.replaces !== undefined) gone.set(fold(one.replaces), one.text)
  }

  return gone
}

// A team decision's key among the open conflicts, beside the entries' ids.
function teamId(one: SharedDecision) {
  return `team:${fold(one.text)}`
}

// Every decision still in force, by folded text.
function inForce(list: readonly Entry[], stored: readonly PastDecision[], team: readonly SharedDecision[]) {
  return new Set(
    [...list.filter(one => one.kind === 'decision'), ...stored, ...team]
      .filter(one => one.replacedBy === undefined)
      .map(one => fold(one.text)),
  )
}

// The standing decisions that contradict another still in force: this
// session's by entry id, the team file's by teamId. One whose other side was
// replaced since has settled.
function openConflicts(
  list: readonly Entry[],
  stored: readonly PastDecision[],
  team: readonly SharedDecision[],
) {
  const standing = inForce(list, stored, team)
  const isOpen = (one: { replacedBy?: string; conflictsWith?: string }) =>
    one.replacedBy === undefined && one.conflictsWith !== undefined && standing.has(fold(one.conflictsWith))

  return new Set([
    ...list.filter(one => one.kind === 'decision' && isOpen(one)).map(one => one.id),
    ...team.filter(isOpen).map(teamId),
  ])
}

// The decisions a share adds: standing, not in the file yet, each text once,
// less any in an open conflict, which are only counted.
function shareable<T extends { text: string; replacedBy?: string; conflictsWith?: string }>(
  local: readonly T[],
  team: readonly SharedDecision[],
) {
  const listed = new Set(team.map(one => fold(one.text)))
  const standing = local.filter(one => one.replacedBy === undefined && !same(one.text, PLAN))
  const inForce = new Set(
    [...team.filter(one => one.replacedBy === undefined), ...standing].map(one => fold(one.text)),
  )
  const added: T[] = []
  const held = new Set<string>()
  for (const one of standing) {
    const key = fold(one.text)
    if (listed.has(key)) continue
    if (one.conflictsWith !== undefined && inForce.has(fold(one.conflictsWith))) {
      held.add(key)
      continue
    }
    listed.add(key)
    added.push(one)
  }

  return { added, held: held.size }
}

// One decision of the shared file: `- **text** — why _(who, 2026-10-19)_`,
// though any bullet counts and every part but the text is optional. A
// struck-through line is not in force.
function parseLine(line: string): SharedDecision | undefined {
  const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(line)
  if (bullet === null) return undefined
  let body = bullet[1]!
  if (body.startsWith('~~')) return undefined
  let who: string | undefined
  let on: string | undefined
  // Greedy, so a name with brackets of its own, `Sam (lead)`, stays whole.
  const meta = /\s*_\((.*)\)_$/.exec(body)
  if (meta !== null) {
    body = body.slice(0, meta.index)
    const parts = meta[1]!.split(',').map(part => part.trim())
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1] ?? '')) on = parts.pop()
    who = parts.join(', ') || undefined
  }
  const bold = /^\*\*(.+?)\*\*(?:\s*[—–-]\s*(.*))?$/.exec(body)
  const dash = / [—–-] /.exec(body)
  const text = (bold !== null ? bold[1]! : dash !== null ? body.slice(0, dash.index) : body)
    .replace(/\*\*/g, '')
    .trim()
  const why = (bold !== null ? bold[2] : dash !== null ? body.slice(dash.index + 3) : undefined)?.trim()
  if (text === '') return undefined

  return {
    text,
    ...(why !== undefined && why !== '' ? { why } : {}),
    ...(who !== undefined ? { who } : {}),
    ...(on !== undefined ? { on } : {}),
  }
}

function parseShared(text: string) {
  return text
    .split('\n')
    .map(parseLine)
    .filter((one): one is SharedDecision => one !== undefined)
}

function sharedLine(one: PastDecision, name: string | undefined) {
  const why = one.why !== undefined ? ` — ${one.why}` : ''
  const who = one.by === 'claude' ? 'Claude' : name
  const d = new Date(one.at)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  return `- **${one.text.replace(/\*\*/g, '')}**${why} _(${who !== undefined ? `${who}, ` : ''}${date})_`
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
      const conflict = one.conflictsWith !== undefined ? ` **Conflicts with:** ${one.conflictsWith}` : ''

      return `**${who} decided:** ${one.text}${why}${alt}${conflict}${sub}`
    }
    case 'assumption': {
      const why = one.why !== undefined ? ` — ${one.why}` : ''
      const answer = one.status === 'rejected' ? ' (you rejected it)' : ' (not confirmed)'

      return `**Claude assumed:** ${one.text}${why}${answer}${sub}`
    }
    case 'edit':
      return `Changed \`${one.text}\`${one.count !== undefined ? ` ×${one.count}` : ''}${sub}`
    case 'run': {
      const drift = one.conflictsWith !== undefined ? ` **Goes against:** ${one.conflictsWith}` : ''

      return `Ran: ${one.text}${one.isError === true ? ' (failed)' : ''}${drift}${sub}`
    }
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

// A shared file's date, 2026-10-19, as `when` shows a day: Oct 19, or today.
function day(on: string, today: number) {
  const [y = 0, m = 1, d = 1] = on.split('-').map(Number)
  const t = new Date(today)
  if (y === t.getFullYear() && m === t.getMonth() + 1 && d === t.getDate()) return 'today'

  return `${MONTHS[m - 1] ?? ''} ${d}`
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
