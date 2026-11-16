import type { GatewayEvent } from '@herald-os/client'
import { atom } from 'nanostores'
import { beforeEach, expect, it, vi } from 'vitest'
import { emptyChat } from '../lib/chat-model.ts'

const edge = vi.hoisted(() => ({ listeners: new Set<(event: GatewayEvent) => void>() }))

vi.mock('./gateway.ts', () => ({
  $connectionEpoch: atom(0),
  gatewayRequest: vi.fn(async () => ({})),
  isGatewayOpen: () => false,
  onAnyGatewayEvent: (listener: (event: GatewayEvent) => void) => {
    edge.listeners.add(listener)
    return () => edge.listeners.delete(listener)
  }
}))

const { $chats } = await import('./chat.ts')
const { $agents, bindAgentEvents, resetAgents } = await import('./agents.ts')
const { $activity, $artifacts, $missions, $todos, bindMissionEvents, resetMissionRuntimeState } = await import('./missions.ts')
const { $runtimeIds, $sessions, rememberRuntimeId, resetRuntimeIds } = await import('./sessions.ts')

function emit(event: GatewayEvent): void {
  for (const listener of edge.listeners) listener(event)
}

beforeEach(() => {
  edge.listeners.clear()
  resetAgents()
  resetMissionRuntimeState()
  resetRuntimeIds()
  $sessions.set([])
  $chats.set({})
})

it('keeps hidden operational-session work out of derived mission and overview stores', () => {
  const hidden = emptyChat('hidden-runtime', 'hidden-stored')
  hidden.hidden = true
  hidden.streaming = true
  hidden.messages.push({ id: 'hidden-tool', role: 'tool', name: 'write_file', toolId: 'hidden-call', args: { path: '/private/hidden.txt' }, result: '', running: false, ts: 1 })
  const visible = emptyChat('visible-runtime', 'visible-stored')
  visible.streaming = true
  visible.messages.push({ id: 'visible-tool', role: 'tool', name: 'write_file', toolId: 'visible-call', args: { path: '/shared/visible.txt' }, result: '', running: false, ts: 2 })
  $chats.set({ [hidden.sessionId]: hidden, [visible.sessionId]: visible })

  const offAgents = bindAgentEvents()
  const offMissions = bindMissionEvents()
  try {
    for (const sessionId of [hidden.sessionId, visible.sessionId]) {
      emit({ type: 'todo.updated', session_id: sessionId, payload: { todos: [{ id: 'one', content: 'Private plan', status: 'in_progress' }], revision: 1 } } as GatewayEvent)
      emit({ type: 'tool.complete', session_id: sessionId, payload: { name: 'write_file', args: { path: `/events/${sessionId}.txt` } } } as GatewayEvent)
      emit({ type: 'subagent.start', session_id: sessionId, payload: { subagent_id: `${sessionId}-agent`, goal: 'Private helper' } } as GatewayEvent)
      emit({ type: 'message.complete', session_id: sessionId, payload: { status: 'complete' } } as GatewayEvent)
    }

    expect(Object.keys($todos.get())).toEqual(['visible-runtime'])
    expect(Object.keys($artifacts.get())).toEqual(['visible-runtime'])
    expect($artifacts.get()['visible-runtime'].map(row => row.path).sort()).toEqual(['/events/visible-runtime.txt', '/shared/visible.txt'])
    expect($activity.get().length).toBeGreaterThan(0)
    expect($activity.get().every(row => row.sessionId === 'visible-runtime')).toBe(true)
    expect(Object.values($agents.get())).toMatchObject([{ parentSessionId: 'visible-runtime' }])
    expect($missions.get().map(mission => mission.runtimeId)).toEqual(['visible-runtime'])
  } finally {
    offMissions()
    offAgents()
  }
})

it('clears every runtime-derived index when a backend epoch changes', () => {
  const chat = emptyChat('old-runtime', 'old-stored')
  $chats.set({ [chat.sessionId]: chat })
  rememberRuntimeId(chat.storedSessionId, chat.sessionId)
  $todos.set({ [chat.sessionId]: { todos: [], revision: 1 } })
  $artifacts.set({ [chat.sessionId]: [{ path: '/old.txt', name: 'old.txt', sessionId: chat.sessionId, tool: 'write_file', ts: 1, kind: 'file' }] })
  $agents.set({ old: { id: 'old', parentSessionId: chat.sessionId, goal: 'Old', status: 'running', lastEvent: 'start', startedAt: 1, updatedAt: 1 } })

  resetMissionRuntimeState()
  resetAgents()
  resetRuntimeIds()

  expect($todos.get()).toEqual({})
  expect($artifacts.get()).toEqual({})
  expect($activity.get()).toEqual([])
  expect($agents.get()).toEqual({})
  expect($runtimeIds.get()).toEqual({})
})
