import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/proj'
const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 160 }

function world(on: On, store: Record<string, unknown> = {}) {
  const time = mock.clock(on, { now: Date.UTC(2026, 9, 19, 12, 0) })
  mock.store(on, store)
  on('session.start', () => ({ cwd: CWD }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'S1' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__trail__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', ($, e) => ({ result: { ok: true }, text: `${e.tool} ran` }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', () => ({ text: '' }))

  return time
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

function pane(surface: 'terminal' | 'desktop') {
  return {
    plugin: 'trail',
    surface,
    component: 'Pane',
    requestId: 'trail',
    props: {
      title: 'Trail',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
}

test('an ask, a decision and repeated edits show up in the pane', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: 'build the trail mod', origin: COMPOSER, wait: false })
  const logged = await $.tool.call({
    tool: 'mcp__trail__decide',
    what: 'Side pane over a web page',
    why: 'It lives where you work.',
    by: 'claude',
  })
  expect(logged.result).toBe('Logged: Side pane over a web page')
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ text: /build the trail mod/ })).toBeDefined()
    expect(await ui.find({ text: /Side pane over a web page/ })).toBeDefined()
    expect(await ui.find({ text: /It lives where you work/ })).toBeDefined()
    expect(await ui.find({ text: /src\/a\.ts ×3/ })).toBeDefined()

    await ui.press({ key: 'tab-files' })
    expect(await ui.find({ text: /Side pane/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /src\/a\.ts/ })).toBeDefined()

    await ui.press({ key: 'tab-decisions' })
    expect(await ui.find({ text: /src\/a\.ts/ })).toBeUndefined()
    expect(await ui.find({ text: /Side pane/ })).toBeDefined()

    await ui.press({ key: 'tab-timeline' })
    await ui.unmount()
  }
})

test('/decide logs your decision and tells the model', async ($, on) => {
  world(on)
  await start($)
  const out = await $.command.run({
    command: 'decide',
    args: 'use SQLite because one user, no server',
    origin: COMPOSER,
    presentation: PRESENTATION,
  })
  expect(out.text).toBe('Logged your decision: use SQLite')
  expect(out.context?.[0]).toContain('because one user, no server')

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /◆ you/ })).toBeDefined()
  expect(await ui.find({ text: /one user, no server/ })).toBeDefined()
})

test('read-only Bash stays out, a change command goes in', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, ($, e) => ({
    result: { stdout: '', stderr: '', interrupted: false },
    text: '',
    ...(e.command.startsWith('ls') ? { isReadOnly: true as const } : {}),
  }))
  world(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'ls -la', description: 'List files' })
  await $.tool.call({ tool: 'Bash', command: 'npm install', description: 'Install deps' })

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /List files/ })).toBeUndefined()
  expect(await ui.find({ text: /Install deps/ })).toBeDefined()
})

test('the guide joins the system prompt only where the tool is offered', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await start($)
  const base = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
  const withTool = await $.prompt.compose({ ...base, tools: ['Read', 'mcp__trail__decide'] })
  expect(withTool.sections.map(one => one.id)).toEqual(['intro', 'trail:guide'])
  const without = await $.prompt.compose({ ...base, tools: ['Read'] })
  expect(without.sections.map(one => one.id)).toEqual(['intro'])
})

test('decisions from an earlier session show under Earlier sessions', async ($, on) => {
  world(on, {
    'past:/proj': [{ session: 'S0', at: Date.UTC(2026, 9, 18, 9, 0), by: 'user', text: 'Postgres, not Mongo' }],
  })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-decisions' })
  expect(await ui.find({ text: /From earlier sessions/ })).toBeDefined()
  expect(await ui.find({ text: /Postgres, not Mongo/ })).toBeDefined()
})

const DECIDE = 'mcp__trail__decide'

test('a skill command opens a group only once it starts a model turn', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: '/help', command: { name: 'help', args: '' }, origin: COMPOSER, wait: false })
  await $.prompt.submit({ text: '/review src', command: { name: 'review', args: 'src' }, origin: COMPOSER, wait: false })
  await $.turn.start({ text: 'the rendered skill body', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/b.ts`, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /\/review src/ })).toBeDefined()
  expect(await ui.find({ text: /\/help/ })).toBeUndefined()
  expect(await ui.find({ text: /rendered skill body/ })).toBeUndefined()
})

test('parallel decisions all persist, and /clear turns them into earlier ones', async ($, on) => {
  world(on)
  await start($)
  await Promise.all(
    [1, 2, 3, 4].map(i => $.tool.call({ tool: DECIDE, what: `Choice ${i}`, why: 'w', by: 'claude' })),
  )
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-decisions' })
  expect(await ui.find({ text: /From earlier sessions/ })).toBeUndefined()
  await ui.unmount()

  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  const after = await $.ui.mount(pane('terminal'))
  expect(await after.find({ text: /From earlier sessions/ })).toBeDefined()
  for (const i of [1, 2, 3, 4]) {
    expect(await after.find({ text: new RegExp(`Choice ${i}`) })).toBeDefined()
  }
})

test('an auto-resolved question is not logged as your decision', async ($, on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const asked = e.questions[0]!
    const isAway = asked.header === 'Away'

    return {
      result: {
        questions: e.questions,
        answers: { [asked.question]: isAway ? 'Default pick' : 'Postgres' },
        ...(isAway ? { afkTimeoutMs: 60000 } : { response: 'and keep it local' }),
      },
      text: '',
    }
  })
  world(on)
  await start($)
  for (const header of ['Away', 'Database']) {
    await $.tool.call({
      tool: 'AskUserQuestion',
      questions: [{ question: `${header}?`, header, options: [], multiSelect: false }],
    })
  }

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /Default pick/ })).toBeUndefined()
  expect(await ui.find({ text: /Database: Postgres/ })).toBeDefined()
  expect(await ui.find({ text: /and keep it local/ })).toBeDefined()
})

test('a long session evicts old runs before any decision', { timeoutMs: 30000 }, async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: DECIDE, what: 'The very first call', why: 'w', by: 'claude' })
  for (let i = 0; i < 510; i++) {
    await $.tool.call({ tool: 'Bash', command: `touch f${i}`, description: `Touch ${i}` })
  }

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /The very first call/ })).toBeDefined()
  expect(await ui.find({ text: /Touch 509/ })).toBeDefined()
})

test('the top line shows what is running right now, and the group its time', async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const atBottom = new Promise<void>(resolve => (reached = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  on('tool.call', { tool: 'mcp__notes__search' }, async () => {
    reached()
    await gate

    return { result: 'ok', text: 'ok' }
  })
  world(on)
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /Idle/ })).toBeDefined()

  await $.prompt.submit({ text: 'find my notes', origin: COMPOSER, wait: false })
  await $.turn.start({ text: 'find my notes', turnId: 't1' })
  const searching = $.tool.call({ tool: 'mcp__notes__search', query: 'x' })
  await atBottom
  expect(await ui.find({ text: /Working 0:00/ })).toBeDefined()
  expect(await ui.find({ text: /notes: search/ })).toBeDefined()
  expect(await ui.find({ text: /^ working$/ })).toBeDefined()

  release()
  await searching
  await $.turn.complete({ answer: '', durationMs: 125000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await ui.find({ text: /Idle/ })).toBeDefined()
  expect(await ui.find({ text: /2m 05s/ })).toBeDefined()
})

test('a question waiting on you shows as Needs you', async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const atBottom = new Promise<void>(resolve => (reached = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    reached()
    await gate

    return { result: { questions: e.questions, answers: {} }, text: '' }
  })
  world(on)
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which?', header: 'Pick', options: [], multiSelect: false }],
  })
  await atBottom
  expect(await ui.find({ text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ text: /Waiting for your answer/ })).toBeDefined()
  release()
  await asking
})

test('a decision can replace an earlier one, in this session or a past one', async ($, on) => {
  world(on, {
    'past:/proj': [{ session: 'S0', at: Date.UTC(2026, 9, 18, 9, 0), by: 'user', text: 'Postgres, not Mongo' }],
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await start($)
  const base = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
  const before = await $.prompt.compose({ ...base, tools: [DECIDE] })
  expect(before.sections.find(one => one.id === 'trail:earlier')?.text).toContain('Postgres, not Mongo')

  await $.tool.call({ tool: DECIDE, what: 'REST API', why: 'w', by: 'claude' })
  const own = await $.tool.call({ tool: DECIDE, what: 'GraphQL API', why: 'w', by: 'user', replaces: 'REST API' })
  expect(own.result).toBe('Logged: GraphQL API (replaces: REST API)')
  const old = await $.tool.call({ tool: DECIDE, what: 'SQLite', why: 'w', by: 'user', replaces: 'postgres' })
  expect(old.result).toBe('Logged: SQLite (replaces: Postgres, not Mongo)')
  const none = await $.tool.call({ tool: DECIDE, what: 'Redis', why: 'w', by: 'claude', replaces: 'nothing like it' })
  expect(none.result).toContain('none was marked replaced')

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /replaced by GraphQL API/ })).toBeDefined()
  expect(await ui.find({ key: 'tab-decisions', text: /Decisions 3/ })).toBeDefined()
  const after = await $.prompt.compose({ ...base, tools: [DECIDE] })
  expect(after.sections.some(one => one.id === 'trail:earlier')).toBe(false)
})

test('pressing a decision drafts a push-back in the prompt', async ($, on) => {
  let drafted = ''
  on('prompt.fill', ($, e) => {
    drafted = e.text

    return { isFilled: true }
  })
  world(on)
  await start($)
  await $.tool.call({ tool: DECIDE, what: 'Tabs over spaces', why: 'w', by: 'claude' })
  const ui = await $.ui.mount(pane('terminal'))
  const button = await ui.find({ type: 'Button', text: /Tabs over spaces/ })
  expect(button).toBeDefined()
  await ui.press({ key: button!.key! })
  expect(drafted).toBe('Revisit "Tabs over spaces": ')
})

test('the working clock ticks while a turn runs', async ($, on) => {
  const time = world(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(pane('terminal'))
  await time.advance(65000)
  expect(await ui.find({ text: /Working 1:05/ })).toBeDefined()
})

test('replaces picks the best match, and refuses to guess between equals', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: DECIDE, what: 'Use SQLite for the cache', why: 'w', by: 'claude' })
  await $.tool.call({ tool: DECIDE, what: 'Use SQLite', why: 'w', by: 'claude' })
  const exact = await $.tool.call({ tool: DECIDE, what: 'Redis for the cache', why: 'w', by: 'claude', replaces: 'use sqlite for the cache' })
  expect(exact.result).toBe('Logged: Redis for the cache (replaces: Use SQLite for the cache)')

  await $.tool.call({ tool: DECIDE, what: 'Tabs in Go files', why: 'w', by: 'claude' })
  await $.tool.call({ tool: DECIDE, what: 'Tabs in Make files', why: 'w', by: 'claude' })
  const vague = await $.tool.call({ tool: DECIDE, what: 'Spaces everywhere', why: 'w', by: 'user', replaces: 'Tabs' })
  expect(vague.result).toContain('Not logged')
  expect(vague.result).toContain('Tabs in Go files; Tabs in Make files')

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /replaced by Redis for the cache/ })).toBeDefined()
  expect(await ui.find({ text: /Spaces everywhere/ })).toBeUndefined()
  expect(await ui.find({ key: 'tab-decisions', text: /Decisions 4/ })).toBeDefined()
})

test('a turn with no ask of its own keeps the last ask time', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: 'do the thing', origin: COMPOSER, wait: false })
  await $.turn.start({ text: 'do the thing', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 125000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 3000, isAborted: true, turnId: 't2', reason: 'aborted' })

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /2m 05s/ })).toBeDefined()
  expect(await ui.find({ text: /stopped/ })).toBeUndefined()
})

test("a background agent's calls outlive the main turn's end", async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const atBottom = new Promise<void>(resolve => (reached = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  on('tool.call', { tool: 'mcp__notes__search' }, async () => {
    reached()
    await gate

    return { result: 'ok', text: 'ok' }
  })
  world(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const searching = $.tool.call({ tool: 'mcp__notes__search', agentId: 'bg1' })
  await atBottom
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ text: /Background/ })).toBeDefined()
  expect(await ui.find({ text: /notes: search \(subagent\)/ })).toBeDefined()
  release()
  await searching
  expect(await ui.find({ text: /Idle/ })).toBeDefined()
})

test('turns fold on a click, a file mentions itself, decisions filter', async ($, on) => {
  let drafted = ''
  on('prompt.fill', ($, e) => {
    drafted = e.text

    return { isFilled: true }
  })
  world(on)
  await start($)
  for (const name of ['one', 'two', 'three']) {
    await $.prompt.submit({ text: `work on ${name}`, origin: COMPOSER, wait: false })
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${name}.ts`, old_string: 'a', new_string: 'b' })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    // The oldest turn starts folded, its change counted.
    expect(await ui.find({ text: /one\.ts/ })).toBeUndefined()
    expect(await ui.find({ text: /\+ 1 change/ })).toBeDefined()
    await ui.press({ key: 'turn-1' })
    expect(await ui.find({ text: /one\.ts/ })).toBeDefined()
    await ui.press({ key: 'turn-1' })
    await ui.unmount()
  }

  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-files' })
  await ui.press({ key: 'file-two.ts' })
  expect(drafted).toBe('@two.ts ')

  await $.tool.call({ tool: DECIDE, what: 'Use Redis', why: 'Already paid for.', by: 'user' })
  await $.tool.call({ tool: DECIDE, what: 'Tabs', why: 'House style.', by: 'claude' })
  await ui.press({ key: 'tab-decisions' })
  await ui.input({ key: 'decision-filter', text: 'paid' })
  expect(await ui.find({ text: /Use Redis/ })).toBeDefined()
  expect(await ui.find({ text: /◆ Tabs/ })).toBeUndefined()
})

test('a fold you chose holds as newer turns arrive', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: 'first', origin: COMPOSER, wait: false })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/first.ts`, old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'turn-1' })
  expect(await ui.find({ text: /first\.ts/ })).toBeUndefined()
  for (const text of ['second', 'third', 'fourth']) {
    await $.prompt.submit({ text, origin: COMPOSER, wait: false })
  }
  expect(await ui.find({ text: /first\.ts/ })).toBeUndefined()
  await ui.press({ key: 'turn-1' })
  expect(await ui.find({ text: /first\.ts/ })).toBeDefined()
})

test('a surface with no filter field shows every decision', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: DECIDE, what: 'Use Redis', why: 'w', by: 'user' })
  await $.tool.call({ tool: DECIDE, what: 'Use tabs', why: 'w', by: 'claude' })
  const terminal = await $.ui.mount(pane('terminal'))
  await terminal.press({ key: 'tab-decisions' })
  await terminal.input({ key: 'decision-filter', text: 'redis' })
  expect(await terminal.find({ text: /Use tabs/ })).toBeUndefined()
  await terminal.unmount()

  const mobile = await $.ui.mount({ ...pane('desktop'), surface: 'mobile' })
  expect(await mobile.find({ text: /Use tabs/ })).toBeDefined()
  expect(await mobile.find({ text: /Use Redis/ })).toBeDefined()
})

test('wide characters wrap by the cells they take', async ($, on) => {
  world(on)
  await start($)
  await $.prompt.submit({ text: `${'漢'.repeat(30)} 👋🏽 done`, origin: COMPOSER, wait: false })
  const ui = await $.ui.mount({ ...pane('terminal'), props: { ...pane('terminal').props, bodyColumns: 25 } })
  // 24 cells less the rail's 3 leave 21: ten wide characters a line.
  expect(await ui.find({ type: 'Text', text: /^漢{10}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^漢{11,}/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /👋🏽 done/ })).toBeDefined()
})
