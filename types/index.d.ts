export type EntryKind = 'ask' | 'decision' | 'assumption' | 'edit' | 'run' | 'agent' | 'skill'

export type Entry = {
  id: string
  turn: number
  at: number
  kind: EntryKind
  by: 'user' | 'claude'
  text: string
  why?: string
  alternatives?: string
  replacedBy?: string
  count?: number
  durationMs?: number
  isAborted?: boolean
  isRunning?: boolean
  isError?: boolean
  isSubagent?: boolean
  // A standing decision this one appears to contradict, by its text; on a
  // commit, the one its changes go against.
  conflictsWith?: string
  // An assumption the person answered: confirmed ones become their decision.
  status?: 'confirmed' | 'rejected'
}

export type View = 'timeline' | 'decisions' | 'files'

export type PastDecision = {
  id?: string
  session: string
  at: number
  by: 'user' | 'claude'
  text: string
  why?: string
  replacedBy?: string
  // The decision this one replaced, by its text: how a replaced team
  // decision is known in later sessions.
  replaces?: string
  conflictsWith?: string
}

// A decision in the project's shared file, as written there.
export type SharedDecision = {
  text: string
  why?: string
  who?: string
  on?: string
  replacedBy?: string
  // A standing decision it appeared to contradict when it arrived.
  conflictsWith?: string
  // Arrived in the file during this session, from someone else.
  isNew?: boolean
}

// What the store keeps per team decision: when this person first saw it,
// and in which session ('' for one they wrote, or that was there before).
export type TeamMark = {
  at: number
  session: string
  conflictsWith?: string
}

// Where a session left off, rebuilt after each of its turns.
export type Handoff = {
  session: string
  at: number
  ask: string
  askAt: number
  durationMs?: number
  isAborted?: boolean
  // The last reply's closing question, when it ended on one.
  question?: string
  files: string[]
  fileCount: number
  // Commands whose last run failed.
  failed: string[]
  conflicts: string[]
  assumptions: string[]
  // Written by the model on /trail handoff.
  summary?: string
  summaryAt?: number
}

export type Activity = {
  id: string
  label: string
  at: number
  agentId?: string
}

export type Live = {
  startedAt: number | null
  now: number
  inflight: Activity[]
}

declare module 'claude-code' {
  interface PluginState {
    trail: {
      entries: Entry[]
      view: View
      turn: number
      past: PastDecision[]
      shared: SharedDecision[]
      live: Live
      // The fold the person chose per turn number: true open, false folded.
      folds: Record<string, boolean>
      search: string
      // The last session's handoff, shown until this one ends.
      handoff: Handoff | null
      // What Claude is told with the next prompt.
      notes: string[]
    }
  }
}
