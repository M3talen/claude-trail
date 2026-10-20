export type EntryKind = 'ask' | 'decision' | 'edit' | 'run' | 'agent' | 'skill'

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
  // A standing decision this one appears to contradict, by its text.
  conflictsWith?: string
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
    }
  }
}
