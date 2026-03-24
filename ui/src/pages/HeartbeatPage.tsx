import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type AppConfig, type EventLogEntry, type HeartbeatAssessment, type HeartbeatSummary } from '../api'
import { Toggle } from '../components/Toggle'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Section, Field, inputClass } from '../components/form'
import { useAutoSave } from '../hooks/useAutoSave'
import { PageHeader } from '../components/PageHeader'

// ==================== Helpers ====================

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour12: false })
  return `${date} ${time}`
}

function eventTypeColor(type: string): string {
  if (type === 'heartbeat.assessment') return 'text-purple'
  if (type === 'heartbeat.done') return 'text-green'
  if (type === 'heartbeat.skip') return 'text-text-muted'
  if (type === 'heartbeat.error') return 'text-red'
  return 'text-purple'
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatConfidence(value: number | null): string {
  if (value == null) return 'n/a'
  return `${Math.round(value)}`
}

function outcomeClass(outcome: HeartbeatAssessment['outcome']): string {
  if (outcome === 'done') return 'text-green'
  if (outcome === 'error') return 'text-red'
  return 'text-text-muted'
}

function compactMapEntries(values: Record<string, number>, limit = 3): string {
  const entries = Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  if (entries.length === 0) return 'n/a'
  return entries.map(([key, count]) => `${key} (${count})`).join(', ')
}

// ==================== Status Bar ====================

function StatusBar() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [triggering, setTriggering] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.heartbeat.status().then(({ enabled }) => setEnabled(enabled)).catch(console.warn)
  }, [])

  const handleToggle = async (v: boolean) => {
    try {
      const result = await api.heartbeat.setEnabled(v)
      setEnabled(result.enabled)
    } catch {
      setError('Failed to toggle heartbeat')
      setTimeout(() => setError(null), 3000)
    }
  }

  const handleTrigger = async () => {
    setTriggering(true)
    setFeedback(null)
    try {
      await api.heartbeat.trigger()
      setFeedback('Heartbeat triggered!')
      setTimeout(() => setFeedback(null), 3000)
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Trigger failed')
      setTimeout(() => setFeedback(null), 5000)
    } finally {
      setTriggering(false)
    }
  }

  return (
    <div className="bg-bg rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg">💓</span>
          <div>
            <div className="text-sm font-medium text-text">Heartbeat</div>
            <div className="text-xs text-text-muted">
              Periodic self-check and autonomous thinking
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {feedback && (
            <span className={`text-xs ${feedback.includes('failed') || feedback.includes('not found') ? 'text-red' : 'text-green'}`}>
              {feedback}
            </span>
          )}

          {error && <span className="text-xs text-red">{error}</span>}

          <button
            onClick={handleTrigger}
            disabled={triggering}
            className="btn-secondary-sm"
          >
            {triggering ? 'Triggering...' : 'Trigger Now'}
          </button>

          {enabled !== null && (
            <Toggle checked={enabled} onChange={handleToggle} />
          )}
        </div>
      </div>
    </div>
  )
}

// ==================== Config Form ====================

function HeartbeatConfigForm({ config }: { config: AppConfig }) {
  const [every, setEvery] = useState(config.heartbeat?.every || '30m')
  const [ahEnabled, setAhEnabled] = useState(config.heartbeat?.activeHours != null)
  const [ahStart, setAhStart] = useState(config.heartbeat?.activeHours?.start || '09:00')
  const [ahEnd, setAhEnd] = useState(config.heartbeat?.activeHours?.end || '22:00')
  const [ahTimezone, setAhTimezone] = useState(config.heartbeat?.activeHours?.timezone || 'local')

  const configData = useMemo(() => ({
    ...config.heartbeat,
    every,
    activeHours: ahEnabled ? { start: ahStart, end: ahEnd, timezone: ahTimezone } : null,
  }), [config.heartbeat, every, ahEnabled, ahStart, ahEnd, ahTimezone])

  const save = useCallback(async (d: Record<string, unknown>) => {
    await api.config.updateSection('heartbeat', d)
  }, [])

  const { status, retry } = useAutoSave({ data: configData, save })

  return (
    <ConfigSection title="Configuration" description="Set how often the heartbeat runs and optionally restrict it to active hours.">
      <Field label="Interval">
        <input
          className={inputClass}
          value={every}
          onChange={(e) => setEvery(e.target.value)}
          placeholder="30m"
        />
      </Field>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <label className="text-[13px] text-text font-medium">Active Hours</label>
          <Toggle checked={ahEnabled} onChange={setAhEnabled} />
        </div>
        {ahEnabled && (
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-[11px] text-text-muted mb-1">Start</label>
              <input
                className={inputClass}
                value={ahStart}
                onChange={(e) => setAhStart(e.target.value)}
                placeholder="09:00"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-text-muted mb-1">End</label>
              <input
                className={inputClass}
                value={ahEnd}
                onChange={(e) => setAhEnd(e.target.value)}
                placeholder="22:00"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-text-muted mb-1">Timezone</label>
              <select
                className={inputClass}
                value={ahTimezone}
                onChange={(e) => setAhTimezone(e.target.value)}
              >
                <option value="local">Local</option>
                <option value="UTC">UTC</option>
                <option value="America/New_York">US Eastern</option>
                <option value="America/Chicago">US Central</option>
                <option value="America/Los_Angeles">US Pacific</option>
                <option value="Europe/London">London</option>
                <option value="Europe/Berlin">Berlin</option>
                <option value="Asia/Tokyo">Tokyo</option>
                <option value="Asia/Shanghai">Shanghai</option>
                <option value="Asia/Hong_Kong">Hong Kong</option>
                <option value="Asia/Singapore">Singapore</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <SaveIndicator status={status} onRetry={retry} />
    </ConfigSection>
  )
}

// ==================== Prompt Editor ====================

function PromptEditor() {
  const [content, setContent] = useState('')
  const [filePath, setFilePath] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.heartbeat.getPromptFile()
      .then(({ content, path }) => {
        setContent(content)
        setFilePath(path)
      })
      .catch(() => setError('Failed to load prompt file'))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.heartbeat.updatePromptFile(content)
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfigSection title="Prompt File" description={filePath || 'The prompt template used for each heartbeat cycle.'}>
      {loading ? (
        <div className="text-sm text-text-muted">Loading...</div>
      ) : (
        <>
          <textarea
            className={`${inputClass} min-h-[200px] max-h-[400px] resize-y font-mono text-xs leading-relaxed`}
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true) }}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="btn-primary-sm"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {saved && (
              <span className="inline-flex items-center gap-1.5 text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full bg-green" />
                <span className="text-text-muted">Saved</span>
              </span>
            )}
            {error && (
              <span className="inline-flex items-center gap-1.5 text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full bg-red" />
                <span className="text-red">{error}</span>
              </span>
            )}
            {dirty && !saved && !error && (
              <span className="text-[11px] text-text-muted">Unsaved changes</span>
            )}
          </div>
        </>
      )}
    </ConfigSection>
  )
}

function SummaryCards() {
  const [summary, setSummary] = useState<HeartbeatSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.heartbeat.summary()
      .then(setSummary)
      .catch(console.warn)
      .finally(() => setLoading(false))
  }, [])

  return (
    <Section title="Evaluation Summary">
      {loading ? (
        <div className="bg-bg rounded-lg border border-border px-4 py-6 text-sm text-text-muted">Loading...</div>
      ) : !summary || summary.totalRuns === 0 ? (
        <div className="bg-bg rounded-lg border border-border px-4 py-6 text-sm text-text-muted">
          No heartbeat assessments yet
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="bg-bg rounded-lg border border-border p-4">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Total Runs</div>
              <div className="mt-1 text-2xl font-semibold text-text">{summary.totalRuns}</div>
            </div>
            <div className="bg-bg rounded-lg border border-border p-4">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Actionable</div>
              <div className="mt-1 text-2xl font-semibold text-text">{summary.actionableCount}</div>
              <div className="text-xs text-text-muted">{formatPercent(summary.actionableRate)} of runs</div>
            </div>
            <div className="bg-bg rounded-lg border border-border p-4">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Delivered</div>
              <div className="mt-1 text-2xl font-semibold text-text">{summary.deliveredCount}</div>
              <div className="text-xs text-text-muted">{formatPercent(summary.deliveredRate)} of runs</div>
            </div>
            <div className="bg-bg rounded-lg border border-border p-4">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Errors</div>
              <div className="mt-1 text-2xl font-semibold text-text">{summary.errorCount}</div>
              <div className="text-xs text-text-muted">{formatPercent(summary.errorRate)} of runs</div>
            </div>
          </div>

          <div className="bg-bg rounded-lg border border-border p-4 text-sm text-text-muted space-y-2">
            <div>Average confidence: <span className="text-text">{formatConfidence(summary.avgConfidence)}</span></div>
            <div>Top actions: <span className="text-text">{compactMapEntries(summary.actionCounts)}</span></div>
            <div>Top skip reasons: <span className="text-text">{compactMapEntries(summary.skipReasonCounts)}</span></div>
            <div>Tracked symbols: <span className="text-text">{compactMapEntries(summary.symbolCounts)}</span></div>
          </div>
        </div>
      )}
    </Section>
  )
}

function RecentAssessments() {
  const [entries, setEntries] = useState<EventLogEntry<HeartbeatAssessment>[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.heartbeat.assessments({ pageSize: 20 })
      .then(({ entries }) => setEntries(entries))
      .catch(console.warn)
      .finally(() => setLoading(false))
  }, [])

  return (
    <Section title="Recent Assessments">
      <div className="bg-bg rounded-lg border border-border overflow-x-auto font-mono text-xs">
        {loading ? (
          <div className="px-4 py-6 text-center text-text-muted">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-text-muted">No heartbeat assessments yet</div>
        ) : (
          <table className="w-full">
            <thead className="bg-bg-secondary">
              <tr className="text-text-muted text-left">
                <th className="px-3 py-2 w-36">Time</th>
                <th className="px-3 py-2 w-20">Outcome</th>
                <th className="px-3 py-2 w-20">Symbol</th>
                <th className="px-3 py-2 w-24">Action</th>
                <th className="px-3 py-2 w-24">Confidence</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.seq} className="border-t border-border/50 hover:bg-bg-tertiary/30 transition-colors align-top">
                  <td className="px-3 py-1.5 text-text-muted whitespace-nowrap">{formatDateTime(entry.ts)}</td>
                  <td className={`px-3 py-1.5 ${outcomeClass(entry.payload.outcome)}`}>{entry.payload.outcome}</td>
                  <td className="px-3 py-1.5 text-text">{entry.payload.symbol || 'NONE'}</td>
                  <td className="px-3 py-1.5 text-text">{entry.payload.action}</td>
                  <td className="px-3 py-1.5 text-text">{formatConfidence(entry.payload.confidence)}</td>
                  <td className="px-3 py-1.5 text-text-muted">
                    <div>{entry.payload.reason || 'No reason provided'}</div>
                    {entry.payload.thesis && <div className="mt-1 text-[11px]">{entry.payload.thesis}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  )
}

// ==================== Recent Events ====================

function RecentEvents() {
  const [entries, setEntries] = useState<EventLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.events.recent({ limit: 500 })
      .then(({ entries }) => {
        const hbEntries = entries
          .filter((e) => e.type.startsWith('heartbeat.'))
          .slice(-20)
          .reverse()
        setEntries(hbEntries)
      })
      .catch(console.warn)
      .finally(() => setLoading(false))
  }, [])

  return (
    <Section title="Recent Events">
      <div className="bg-bg rounded-lg border border-border overflow-x-auto font-mono text-xs">
        {loading ? (
          <div className="px-4 py-6 text-center text-text-muted">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-text-muted">No heartbeat events yet</div>
        ) : (
          <table className="w-full">
            <thead className="bg-bg-secondary">
              <tr className="text-text-muted text-left">
                <th className="px-3 py-2 w-12">#</th>
                <th className="px-3 py-2 w-36">Time</th>
                <th className="px-3 py-2 w-32">Type</th>
                <th className="px-3 py-2">Payload</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const payloadStr = JSON.stringify(entry.payload)
                return (
                  <tr key={entry.seq} className="border-t border-border/50 hover:bg-bg-tertiary/30 transition-colors">
                    <td className="px-3 py-1.5 text-text-muted">{entry.seq}</td>
                    <td className="px-3 py-1.5 text-text-muted whitespace-nowrap">{formatDateTime(entry.ts)}</td>
                    <td className={`px-3 py-1.5 ${eventTypeColor(entry.type)}`}>
                      {entry.type.replace('heartbeat.', '')}
                    </td>
                    <td className="px-3 py-1.5 text-text-muted truncate max-w-0">
                      {payloadStr.length > 120 ? payloadStr.slice(0, 120) + '...' : payloadStr}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  )
}

// ==================== Main Page ====================

export function HeartbeatPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    api.config.load().then(setConfig).catch(console.warn)
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Heartbeat" />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5">
        <div className="max-w-[880px] mx-auto space-y-6">
          <StatusBar />
          {config && <HeartbeatConfigForm config={config} />}
          <SummaryCards />
          <RecentAssessments />
          <PromptEditor />
          <RecentEvents />
        </div>
      </div>
    </div>
  )
}
