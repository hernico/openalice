import { headers } from './client'
import type { EventQueryResult } from './events'
import type { HeartbeatAssessment, HeartbeatSummary } from './types'

export const heartbeatApi = {
  async status(): Promise<{ enabled: boolean }> {
    const res = await fetch('/api/heartbeat/status')
    if (!res.ok) throw new Error('Failed to get heartbeat status')
    return res.json()
  },

  async trigger(): Promise<void> {
    const res = await fetch('/api/heartbeat/trigger', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Trigger failed' }))
      throw new Error(err.error || 'Trigger failed')
    }
  },

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    const res = await fetch('/api/heartbeat/enabled', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Update failed' }))
      throw new Error(err.error || 'Update failed')
    }
    return res.json()
  },

  async getPromptFile(): Promise<{ content: string; path: string }> {
    const res = await fetch('/api/heartbeat/prompt-file')
    if (!res.ok) throw new Error('Failed to load prompt file')
    return res.json()
  },

  async updatePromptFile(content: string): Promise<void> {
    const res = await fetch('/api/heartbeat/prompt-file', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error('Failed to save prompt file')
  },

  async summary(): Promise<HeartbeatSummary> {
    const res = await fetch('/api/heartbeat/summary')
    if (!res.ok) throw new Error('Failed to load heartbeat summary')
    return res.json()
  },

  async assessments(opts: { page?: number; pageSize?: number } = {}): Promise<EventQueryResult<HeartbeatAssessment>> {
    const params = new URLSearchParams()
    if (opts.page) params.set('page', String(opts.page))
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    const qs = params.toString()
    const res = await fetch(`/api/heartbeat/assessments${qs ? `?${qs}` : ''}`)
    if (!res.ok) throw new Error('Failed to load heartbeat assessments')
    return res.json()
  },
}
