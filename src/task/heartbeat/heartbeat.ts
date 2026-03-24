/**
 * Heartbeat — periodic AI self-check, built on top of the cron engine.
 *
 * Registers a cron job (`__heartbeat__`) that fires at a configured interval.
 * When fired, calls the AI engine and filters the response:
 *   1. Active hours guard — skip if outside configured window
 *   2. AI call — agentCenter.askWithSession(prompt, heartbeatSession)
 *   3. Ack token filter — skip if AI says "nothing to report"
 *   4. Dedup — skip if same text was sent within 24h
 *   5. Send — connectorCenter.notify(text)
 *
 * Events written to eventLog:
 *   - heartbeat.assessment { structured decision record for every tick }
 *   - heartbeat.done       { reply, durationMs, delivered }
 *   - heartbeat.skip       { reason }
 *   - heartbeat.error      { error, durationMs }
 */

import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import type { AgentCenter } from '../../core/agent-center.js'
import { SessionStore } from '../../core/session.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import { writeConfigSection } from '../../core/config.js'
import type { CronEngine, CronFirePayload } from '../cron/engine.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// ==================== Constants ====================

export const HEARTBEAT_JOB_NAME = '__heartbeat__'

// ==================== Config ====================

export interface HeartbeatConfig {
  enabled: boolean
  /** Interval between heartbeats, e.g. "30m", "1h". */
  every: string
  /** Prompt sent to the AI on each heartbeat. */
  prompt: string
  /** Active hours window. Null = always active. */
  activeHours: {
    start: string   // "HH:MM"
    end: string     // "HH:MM"
    timezone: string // IANA timezone or "local"
  } | null
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: false,
  every: '30m',
  prompt: `Check if anything needs attention. Respond using the structured format below.

## Response Format

STATUS: HEARTBEAT_OK | CHAT_YES
REASON: <brief explanation of your decision>
CONTENT: <message to deliver, only when STATUS is CHAT_YES>

## Rules

- If in doubt, prefer CHAT_YES over HEARTBEAT_OK — better to over-report than to miss something.
- Keep CONTENT concise but actionable.

## Examples

If nothing to report:
STATUS: HEARTBEAT_OK
REASON: All systems normal, no alerts or notable changes.

If you want to send a message:
STATUS: CHAT_YES
REASON: Significant price movement detected.
CONTENT: BTC just dropped 8% in the last hour — now at $87,200. This may trigger stop-losses.`,
  activeHours: null,
}

// ==================== Types ====================

export interface HeartbeatOpts {
  config: HeartbeatConfig
  connectorCenter: ConnectorCenter
  cronEngine: CronEngine
  eventLog: EventLog
  agentCenter: AgentCenter
  /** Optional: inject a session for testing. */
  session?: SessionStore
  /** Inject clock for testing. */
  now?: () => number
}

export interface Heartbeat {
  start(): Promise<void>
  stop(): void
  /** Hot-toggle heartbeat on/off (persists to config + updates cron job). */
  setEnabled(enabled: boolean): Promise<void>
  /** Current enabled state. */
  isEnabled(): boolean
}

const FILE_PROMPT_RE = /^Read\s+(.+?)\s+\(or\s+(.+?)\s+if not found\)\s+and follow the instructions inside\.?$/i

export async function resolveHeartbeatPrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim()
  const match = FILE_PROMPT_RE.exec(trimmed)
  if (!match) return prompt

  const candidates = [match[1], match[2]].map((value) => resolve(value.trim()))
  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf-8')
      if (content.trim()) return content
    } catch {
      // Try next candidate.
    }
  }

  return prompt
}

// ==================== Factory ====================

export function createHeartbeat(opts: HeartbeatOpts): Heartbeat {
  const { config, connectorCenter, cronEngine, eventLog, agentCenter } = opts
  const session = opts.session ?? new SessionStore('heartbeat')
  const now = opts.now ?? Date.now

  let unsubscribe: (() => void) | null = null
  let jobId: string | null = null
  let processing = false
  let enabled = config.enabled

  const dedup = new HeartbeatDedup()

  async function appendAssessment(assessment: HeartbeatAssessment): Promise<void> {
    await eventLog.append('heartbeat.assessment', assessment)
  }

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as CronFirePayload

    // Only handle our own job
    if (payload.jobName !== HEARTBEAT_JOB_NAME) return

    // Guard: skip if already processing
    if (processing) return

    processing = true
    const startMs = now()
    console.log(`heartbeat: firing at ${new Date(startMs).toISOString()}`)

    try {
      // 1. Active hours guard
      if (!isWithinActiveHours(config.activeHours, now())) {
        console.log('heartbeat: skipped (outside active hours)')
        await appendAssessment({
          source: 'system',
          status: 'SYSTEM_SKIP',
          outcome: 'skip',
          skipReason: 'outside-active-hours',
          reason: 'Heartbeat skipped because the current time is outside the configured active hours window.',
          actionable: false,
          symbol: null,
          bias: 'FLAT',
          confidence: null,
          action: 'NONE',
          thesis: '',
          risk: '',
          content: '',
          delivered: null,
          durationMs: now() - startMs,
          unparsed: false,
        })
        await eventLog.append('heartbeat.skip', { reason: 'outside-active-hours' })
        return
      }

      // 2. Call AI
      const resolvedPrompt = await resolveHeartbeatPrompt(payload.payload)
      const result = await agentCenter.askWithSession(resolvedPrompt, session, {
        historyPreamble: 'The following is the recent heartbeat conversation history.',
      })
      const durationMs = now() - startMs
      const normalizedResultText = preprocessHeartbeatResponse(result.text)

      // 3. Parse structured response
      const parsed = parseHeartbeatResponse(result.text)
      const baseAssessment: Omit<HeartbeatAssessment, 'outcome' | 'skipReason' | 'delivered'> = {
        source: 'ai',
        status: parsed.status,
        reason: parsed.reason,
        actionable: parsed.actionable,
        symbol: parsed.symbol,
        bias: parsed.bias,
        confidence: parsed.confidence,
        action: parsed.action,
        thesis: parsed.thesis,
        risk: parsed.risk,
        content: parsed.status === 'CHAT_YES'
          ? parsed.content || normalizedResultText
          : '',
        durationMs,
        unparsed: parsed.unparsed,
      }

      if (parsed.status === 'HEARTBEAT_OK') {
        console.log(`heartbeat: HEARTBEAT_OK — ${parsed.reason || 'no reason'} (${durationMs}ms)`)
        await appendAssessment({
          ...baseAssessment,
          outcome: 'skip',
          skipReason: 'ack',
          delivered: null,
        })
        await eventLog.append('heartbeat.skip', {
          reason: 'ack',
          parsedReason: parsed.reason,
        })
        return
      }

      // CHAT_YES (or unparsed fallback)
      const text = parsed.content || result.text
      if (!text.trim()) {
        console.log(`heartbeat: skipped (empty content) (${durationMs}ms)`)
        await appendAssessment({
          ...baseAssessment,
          outcome: 'skip',
          skipReason: 'empty',
          delivered: null,
        })
        await eventLog.append('heartbeat.skip', { reason: 'empty' })
        return
      }

      // 4. Dedup
      if (dedup.isDuplicate(text, now())) {
        console.log(`heartbeat: skipped (duplicate) (${durationMs}ms)`)
        await appendAssessment({
          ...baseAssessment,
          outcome: 'skip',
          skipReason: 'duplicate',
          delivered: null,
        })
        await eventLog.append('heartbeat.skip', { reason: 'duplicate' })
        return
      }

      // 5. Send notification
      let delivered = false
      try {
        const result2 = await connectorCenter.notify(text, {
          media: result.media,
          source: 'heartbeat',
        })
        delivered = result2.delivered
        if (delivered) dedup.record(text, now())
      } catch (sendErr) {
        console.warn('heartbeat: send failed:', sendErr)
      }

      console.log(`heartbeat: CHAT_YES — delivered=${delivered} (${durationMs}ms)`)

      // 6. Done event
      await appendAssessment({
        ...baseAssessment,
        outcome: 'done',
        skipReason: null,
        delivered,
      })
      await eventLog.append('heartbeat.done', {
        reply: text,
        reason: parsed.reason,
        durationMs,
        delivered,
      })
    } catch (err) {
      console.error('heartbeat: error:', err)
      await appendAssessment({
        source: 'system',
        status: 'ERROR',
        outcome: 'error',
        skipReason: 'error',
        reason: err instanceof Error ? err.message : String(err),
        actionable: false,
        symbol: null,
        bias: 'UNKNOWN',
        confidence: null,
        action: 'NONE',
        thesis: '',
        risk: '',
        content: '',
        delivered: null,
        durationMs: now() - startMs,
        unparsed: false,
      })
      await eventLog.append('heartbeat.error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: now() - startMs,
      })
    } finally {
      processing = false
    }
  }

  /** Ensure the cron job and event listener exist (idempotent). */
  async function ensureJobAndListener(): Promise<void> {
    // Idempotent: find existing heartbeat job or create one
    const existing = cronEngine.list().find((j) => j.name === HEARTBEAT_JOB_NAME)
    if (existing) {
      jobId = existing.id
      await cronEngine.update(existing.id, {
        schedule: { kind: 'every', every: config.every },
        payload: config.prompt,
        enabled,
      })
    } else {
      jobId = await cronEngine.add({
        name: HEARTBEAT_JOB_NAME,
        schedule: { kind: 'every', every: config.every },
        payload: config.prompt,
        enabled,
      })
    }

    // Subscribe to cron.fire events if not already subscribed
    if (!unsubscribe) {
      unsubscribe = eventLog.subscribeType('cron.fire', (entry) => {
        handleFire(entry).catch((err) => {
          console.error('heartbeat: unhandled error:', err)
        })
      })
    }
  }

  return {
    async start() {
      // Always register job + listener (even if disabled) so setEnabled can toggle later
      await ensureJobAndListener()
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
      // Don't delete the cron job — it persists for restart recovery
    },

    async setEnabled(newEnabled: boolean) {
      enabled = newEnabled

      // Ensure infrastructure exists (handles cold enable when start() was called with disabled)
      await ensureJobAndListener()

      // Persist to config file
      await writeConfigSection('heartbeat', { ...config, enabled: newEnabled })
    },

    isEnabled() {
      return enabled
    },
  }
}

// ==================== Response Parser ====================

export type HeartbeatStatus = 'HEARTBEAT_OK' | 'CHAT_YES'
export type HeartbeatAssessmentStatus = HeartbeatStatus | 'SYSTEM_SKIP' | 'ERROR'
export type HeartbeatAssessmentOutcome = 'done' | 'skip' | 'error'
export type HeartbeatAssessmentSource = 'ai' | 'system'
export type HeartbeatBias = 'LONG' | 'SHORT' | 'FLAT' | 'UNKNOWN'
export type HeartbeatAction = 'BUY' | 'SELL' | 'WATCH' | 'HOLD' | 'REDUCE' | 'EXIT' | 'NONE'

export interface ParsedHeartbeatResponse {
  status: HeartbeatStatus
  reason: string
  content: string
  actionable: boolean
  symbol: string | null
  bias: HeartbeatBias
  confidence: number | null
  action: HeartbeatAction
  thesis: string
  risk: string
  /** True when the raw response couldn't be parsed into the structured format. */
  unparsed: boolean
}

export interface HeartbeatAssessment {
  source: HeartbeatAssessmentSource
  status: HeartbeatAssessmentStatus
  outcome: HeartbeatAssessmentOutcome
  skipReason: string | null
  reason: string
  actionable: boolean
  symbol: string | null
  bias: HeartbeatBias
  confidence: number | null
  action: HeartbeatAction
  thesis: string
  risk: string
  content: string
  delivered: boolean | null
  durationMs: number
  unparsed: boolean
}

export interface HeartbeatAssessmentSummary {
  totalRuns: number
  doneCount: number
  skipCount: number
  errorCount: number
  actionableCount: number
  deliveredCount: number
  avgConfidence: number | null
  actionableRate: number
  deliveredRate: number
  errorRate: number
  uniqueSymbols: string[]
  symbolCounts: Record<string, number>
  outcomeCounts: Record<HeartbeatAssessmentOutcome, number>
  actionCounts: Record<HeartbeatAction, number>
  biasCounts: Record<HeartbeatBias, number>
  skipReasonCounts: Record<string, number>
  lastRunAt: string | null
  lastActionableAt: string | null
  lastDeliveredAt: string | null
  lastErrorAt: string | null
}

/**
 * Parse a structured heartbeat response from the AI.
 *
 * Expected format:
 *   STATUS: HEARTBEAT_OK | CHAT_YES
 *   REASON: <text>
 *   CONTENT: <text>       (only for CHAT_YES)
 *
 * If the response doesn't match the expected format, treats the entire
 * raw text as a CHAT_YES message (fail-open: deliver rather than swallow).
 */
export function parseHeartbeatResponse(raw: string): ParsedHeartbeatResponse {
  const trimmed = preprocessHeartbeatResponse(raw)
  if (!trimmed) {
    return {
      status: 'HEARTBEAT_OK',
      reason: 'empty response',
      content: '',
      actionable: false,
      symbol: null,
      bias: 'FLAT',
      confidence: null,
      action: 'NONE',
      thesis: '',
      risk: '',
      unparsed: false,
    }
  }

  // Extract STATUS field (case-insensitive, allows leading whitespace on the line)
  const statusMatch = /^\s*STATUS:\s*(HEARTBEAT_OK|CHAT_YES)\s*$/im.exec(trimmed)
  if (!statusMatch) {
    // Fail-open: can't parse → treat as a message to deliver
    return {
      status: 'CHAT_YES',
      reason: 'unparsed response',
      content: trimmed,
      actionable: true,
      symbol: null,
      bias: 'UNKNOWN',
      confidence: null,
      action: 'WATCH',
      thesis: '',
      risk: '',
      unparsed: true,
    }
  }

  const status = statusMatch[1].toUpperCase() as HeartbeatStatus

  const reason = extractStructuredField(trimmed, 'REASON')
  const content = extractStructuredField(trimmed, 'CONTENT')
  const actionable = parseActionable(extractStructuredField(trimmed, 'ACTIONABLE'), status)
  const symbol = normalizeSymbolField(extractStructuredField(trimmed, 'SYMBOL'))
  const bias = normalizeBias(extractStructuredField(trimmed, 'BIAS'), status)
  const confidence = parseConfidence(extractStructuredField(trimmed, 'CONFIDENCE'))
  const action = normalizeAction(extractStructuredField(trimmed, 'ACTION'), status)
  const thesis = extractStructuredField(trimmed, 'THESIS')
  const risk = extractStructuredField(trimmed, 'RISK')

  return {
    status,
    reason,
    content,
    actionable,
    symbol,
    bias,
    confidence,
    action,
    thesis,
    risk,
    unparsed: false,
  }
}

function extractStructuredField(raw: string, field: string): string {
  const allFields = [
    'STATUS',
    'REASON',
    'ACTIONABLE',
    'SYMBOL',
    'BIAS',
    'CONFIDENCE',
    'ACTION',
    'THESIS',
    'RISK',
    'CONTENT',
  ]
  const lookahead = allFields.join('|')
  const match = new RegExp(
    `(?:^|\\n)\\s*${field}:\\s*([\\s\\S]+?)(?=\\n\\s*(?:${lookahead}):|$)`,
    'i',
  ).exec(raw)
  return sanitizeStructuredField(match?.[1] ?? '')
}

function preprocessHeartbeatResponse(raw: string): string {
  const cleaned = stripAnsiAndControl(raw).trim()
  if (!cleaned) return ''

  const fencedMatch = /```[^\n]*\n([\s\S]*?)\n```/i.exec(cleaned)
  if (fencedMatch && /^\s*STATUS:/im.test(fencedMatch[1] ?? '')) {
    return stripAnsiAndControl(fencedMatch[1] ?? '').trim()
  }

  return cleaned
}

function sanitizeStructuredField(value: string): string {
  return stripAnsiAndControl(value).trim()
}

function stripAnsiAndControl(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '')
}

function parseActionable(value: string, status: HeartbeatStatus): boolean {
  if (!value) return status === 'CHAT_YES'
  return /^(yes|y|true|1)$/i.test(value.trim())
}

function normalizeSymbolField(value: string): string | null {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  if (!normalized || ['NONE', 'NULL', 'N/A', 'NA'].includes(normalized)) return null
  return normalized
}

function normalizeBias(value: string, status: HeartbeatStatus): HeartbeatBias {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'LONG' || normalized === 'SHORT' || normalized === 'FLAT' || normalized === 'UNKNOWN') {
    return normalized
  }
  return status === 'HEARTBEAT_OK' ? 'FLAT' : 'UNKNOWN'
}

function normalizeAction(value: string, status: HeartbeatStatus): HeartbeatAction {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'BUY' || normalized === 'SELL' || normalized === 'WATCH' || normalized === 'HOLD'
    || normalized === 'REDUCE' || normalized === 'EXIT' || normalized === 'NONE') {
    return normalized
  }
  return status === 'HEARTBEAT_OK' ? 'NONE' : 'WATCH'
}

function parseConfidence(value: string): number | null {
  if (!value) return null
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.min(100, parsed))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function normalizeHeartbeatAssessment(payload: unknown): HeartbeatAssessment | null {
  if (!isRecord(payload)) return null

  const source = payload.source === 'ai' || payload.source === 'system' ? payload.source : null
  const status = payload.status === 'HEARTBEAT_OK'
    || payload.status === 'CHAT_YES'
    || payload.status === 'SYSTEM_SKIP'
    || payload.status === 'ERROR'
    ? payload.status
    : null
  const outcome = payload.outcome === 'done' || payload.outcome === 'skip' || payload.outcome === 'error'
    ? payload.outcome
    : null
  const bias = payload.bias === 'LONG' || payload.bias === 'SHORT' || payload.bias === 'FLAT' || payload.bias === 'UNKNOWN'
    ? payload.bias
    : null
  const action = payload.action === 'BUY' || payload.action === 'SELL' || payload.action === 'WATCH'
    || payload.action === 'HOLD' || payload.action === 'REDUCE' || payload.action === 'EXIT' || payload.action === 'NONE'
    ? payload.action
    : null
  const actionable = asBoolean(payload.actionable)
  const durationMs = asNumber(payload.durationMs)
  const unparsed = asBoolean(payload.unparsed)

  if (!source || !status || !outcome || !bias || !action || actionable === null || durationMs === null || unparsed === null) {
    return null
  }

  return {
    source,
    status,
    outcome,
    skipReason: asString(payload.skipReason),
    reason: asString(payload.reason) ?? '',
    actionable,
    symbol: normalizeSymbolField(asString(payload.symbol) ?? ''),
    bias,
    confidence: asNumber(payload.confidence),
    action,
    thesis: asString(payload.thesis) ?? '',
    risk: asString(payload.risk) ?? '',
    content: asString(payload.content) ?? '',
    delivered: asBoolean(payload.delivered),
    durationMs,
    unparsed,
  }
}

function incrementCount(bucket: Record<string, number>, key: string | null | undefined): void {
  if (!key) return
  bucket[key] = (bucket[key] ?? 0) + 1
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total
}

export function summarizeHeartbeatAssessments(entries: EventLogEntry[]): HeartbeatAssessmentSummary {
  const actionCounts: Record<HeartbeatAction, number> = {
    BUY: 0,
    SELL: 0,
    WATCH: 0,
    HOLD: 0,
    REDUCE: 0,
    EXIT: 0,
    NONE: 0,
  }
  const biasCounts: Record<HeartbeatBias, number> = {
    LONG: 0,
    SHORT: 0,
    FLAT: 0,
    UNKNOWN: 0,
  }
  const outcomeCounts: Record<HeartbeatAssessmentOutcome, number> = {
    done: 0,
    skip: 0,
    error: 0,
  }
  const skipReasonCounts: Record<string, number> = {}
  const symbolCounts: Record<string, number> = {}

  let totalRuns = 0
  let actionableCount = 0
  let deliveredCount = 0
  let confidenceTotal = 0
  let confidenceCount = 0
  let lastRunAt: string | null = null
  let lastActionableAt: string | null = null
  let lastDeliveredAt: string | null = null
  let lastErrorAt: string | null = null

  for (const entry of entries) {
    const assessment = normalizeHeartbeatAssessment(entry.payload)
    if (!assessment) continue

    totalRuns += 1
    outcomeCounts[assessment.outcome] += 1
    actionCounts[assessment.action] += 1
    biasCounts[assessment.bias] += 1
    incrementCount(skipReasonCounts, assessment.skipReason)
    incrementCount(symbolCounts, assessment.symbol)

    const tsIso = new Date(entry.ts).toISOString()
    lastRunAt = tsIso

    if (assessment.actionable) {
      actionableCount += 1
      lastActionableAt = tsIso
    }
    if (assessment.delivered) {
      deliveredCount += 1
      lastDeliveredAt = tsIso
    }
    if (assessment.outcome === 'error') {
      lastErrorAt = tsIso
    }
    if (assessment.confidence !== null) {
      confidenceTotal += assessment.confidence
      confidenceCount += 1
    }
  }

  return {
    totalRuns,
    doneCount: outcomeCounts.done,
    skipCount: outcomeCounts.skip,
    errorCount: outcomeCounts.error,
    actionableCount,
    deliveredCount,
    avgConfidence: confidenceCount > 0 ? confidenceTotal / confidenceCount : null,
    actionableRate: ratio(actionableCount, totalRuns),
    deliveredRate: ratio(deliveredCount, totalRuns),
    errorRate: ratio(outcomeCounts.error, totalRuns),
    uniqueSymbols: Object.keys(symbolCounts).sort(),
    symbolCounts,
    outcomeCounts,
    actionCounts,
    biasCounts,
    skipReasonCounts,
    lastRunAt,
    lastActionableAt,
    lastDeliveredAt,
    lastErrorAt,
  }
}

// ==================== Active Hours ====================

/**
 * Check if the current time falls within the active hours window.
 * Returns true if no activeHours configured (always active).
 */
export function isWithinActiveHours(
  activeHours: HeartbeatConfig['activeHours'],
  nowMs?: number,
): boolean {
  if (!activeHours) return true

  const { start, end, timezone } = activeHours

  const startMinutes = parseHHMM(start)
  const endMinutes = parseHHMM(end)
  if (startMinutes === null || endMinutes === null) return true

  const nowMinutes = currentMinutesInTimezone(timezone, nowMs)

  // Normal range (e.g. 09:00 → 22:00)
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes
  }

  // Overnight range (e.g. 22:00 → 06:00)
  return nowMinutes >= startMinutes || nowMinutes < endMinutes
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function currentMinutesInTimezone(tz: string, nowMs?: number): number {
  const date = nowMs ? new Date(nowMs) : new Date()

  if (tz === 'local') {
    return date.getHours() * 60 + date.getMinutes()
  }

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    const parts = fmt.formatToParts(date)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    return date.getHours() * 60 + date.getMinutes()
  }
}

// ==================== Dedup ====================

/**
 * Suppress identical heartbeat messages within a time window (default 24h).
 */
export class HeartbeatDedup {
  private lastText: string | null = null
  private lastSentAt = 0
  private windowMs: number

  constructor(windowMs = 24 * 60 * 60 * 1000) {
    this.windowMs = windowMs
  }

  isDuplicate(text: string, nowMs = Date.now()): boolean {
    if (this.lastText === null) return false
    if (text !== this.lastText) return false
    return (nowMs - this.lastSentAt) < this.windowMs
  }

  record(text: string, nowMs = Date.now()): void {
    this.lastText = text
    this.lastSentAt = nowMs
  }
}
