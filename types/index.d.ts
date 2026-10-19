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
      live: Live
      // The fold the person chose per turn number: true open, false folded.
      folds: Record<string, boolean>
      search: string
    }
  }
}
