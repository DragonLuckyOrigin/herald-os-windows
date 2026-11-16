import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatState } from '../lib/chat-model.ts'
import type { PendingRequest } from '../store/requests.ts'

vi.hoisted(() => Object.assign(globalThis, {
  window: { heraldOS: { office: { onChanged: () => () => undefined } } },
  document: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }
}))

const { $petHeldApproval } = await import('../features/pet/transport.ts')
const { $chats } = await import('../store/chat.ts')
const { $pendingRequests } = await import('../store/requests.ts')
const { $voice, $voiceAnswerableApprovalId, $voiceApprovalSessionId } = await import('../store/voice.ts')
const { RequestHost } = await import('./RequestHost.tsx')

const initialVoice = $voice.get()
const initialChats = $chats.get()

function approval(id: string, sessionId: string, description: string): PendingRequest {
  return {
    kind: 'approval',
    receivedAt: 0,
    request: {
      id,
      method: 'approval',
      params: { session_id: sessionId, description },
      respond: vi.fn()
    }
  } as unknown as PendingRequest
}

afterEach(() => {
  $petHeldApproval.set(null)
  $pendingRequests.set([])
  $chats.set(initialChats)
  $voiceApprovalSessionId.set(null)
  $voice.set(initialVoice)
})

function arrangeVoiceApproval() {
  const pet = approval('pet-card', 'other-session', 'Pet approval')
  const voice = approval('voice-card', 'voice-session', 'Voice approval')
  $voice.set({ ...initialVoice, state: 'listening', engine: 'chained' })
  $voiceApprovalSessionId.set('voice-session')
  $chats.set({ ...initialChats, 'voice-session': {} as ChatState })

  return { pet, voice }
}

it('shows a voice hint for the globally answerable card through the real request host', () => {
  const { voice } = arrangeVoiceApproval()
  $pendingRequests.set([voice])

  expect($voiceAnswerableApprovalId.get()).toBe(voice.request.id)
  const html = renderToStaticMarkup(createElement(RequestHost))
  expect(html).toContain('Voice approval')
  expect(html).toContain('tabler-icon-microphone')
})

it('does not promise a voice answer for a card displayed behind a pet-held request', () => {
  const { pet, voice } = arrangeVoiceApproval()
  $petHeldApproval.set(pet.request.id)

  $pendingRequests.set([pet, voice])
  expect($voiceAnswerableApprovalId.get()).toBeNull()
  const html = renderToStaticMarkup(createElement(RequestHost))
  expect(html).toContain('Voice approval')
  expect(html).not.toContain('tabler-icon-microphone')
})

it('does not promise a voice answer for a card without a live chat', () => {
  const { voice } = arrangeVoiceApproval()
  $pendingRequests.set([voice])

  $chats.set(initialChats)
  expect($voiceAnswerableApprovalId.get()).toBeNull()
  const html = renderToStaticMarkup(createElement(RequestHost))
  expect(html).toContain('Voice approval')
  expect(html).not.toContain('tabler-icon-microphone')
})
