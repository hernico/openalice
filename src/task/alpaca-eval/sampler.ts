import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RawData } from 'ws'
import WebSocket from 'ws'
import type { Config } from '../../core/config.js'
import type { EventLog } from '../../core/event-log.js'
import type { UnifiedTradingAccount } from '../../domain/trading/UnifiedTradingAccount.js'
import type { AccountInfo, MarketClock, OpenOrder, Position } from '../../domain/trading/brokers/types.js'

type AlpacaEvalConfig = Config['alpacaEval']

type RecentKind = 'market-seconds' | 'trade-updates' | 'account-snapshots'
type SnapshotReason = 'interval' | 'trade-update' | 'startup'

interface QuoteState {
  bid: number | null
  ask: number | null
  bidSize: number | null
  askSize: number | null
  bidExchange: string | null
  askExchange: string | null
  timestamp: string | null
}

interface TradeState {
  price: number | null
  size: number | null
  exchange: string | null
  conditions: string[]
  tape: string | null
  timestamp: string | null
}

interface SymbolState {
  quote: QuoteState
  trade: TradeState
}

interface MarketClockState {
  isOpen: boolean
  nextOpen: string | null
  nextClose: string | null
  timestamp: string | null
}

export interface AlpacaMarketSecondSymbolRecord {
  bid: number | null
  ask: number | null
  spread: number | null
  bidSize: number | null
  askSize: number | null
  bidExchange: string | null
  askExchange: string | null
  quoteTimestamp: string | null
  last: number | null
  lastSize: number | null
  tradeExchange: string | null
  tradeConditions: string[]
  tape: string | null
  tradeTimestamp: string | null
}

export interface AlpacaMarketSecondRecord {
  type: 'market-second'
  accountId: string
  feed: 'iex' | 'sip'
  sampleTs: string
  marketClock: MarketClockState | null
  symbols: Record<string, AlpacaMarketSecondSymbolRecord>
}

export interface AlpacaTradeUpdateRecord {
  type: 'trade-update'
  accountId: string
  ts: string
  event: string
  orderId: string | null
  clientOrderId: string | null
  symbol: string | null
  side: string | null
  status: string | null
  qty: string | null
  filledQty: string | null
  filledAvgPrice: string | null
  raw: Record<string, unknown>
}

export interface AlpacaSnapshotAccountRecord {
  netLiquidation: number
  totalCashValue: number
  unrealizedPnL: number
  realizedPnL: number
  buyingPower?: number
  dayTradesRemaining?: number
}

export interface AlpacaSnapshotPositionRecord {
  symbol: string
  side: 'long' | 'short'
  quantity: string
  avgCost: number
  marketPrice: number
  marketValue: number
  unrealizedPnL: number
  realizedPnL: number
  leverage: number
}

export interface AlpacaSnapshotOrderRecord {
  symbol: string
  side: string
  quantity: string
  orderType: string
  timeInForce: string
  limitPrice: number | null
  stopPrice: number | null
  status: string
  warningText: string | null
}

export interface AlpacaEvaluationViewRecord {
  excludedSymbols: string[]
  excludedPositionCount: number
  excludedOrderCount: number
  excludedMarketValue: number
  excludedUnrealizedPnL: number
  account: AlpacaSnapshotAccountRecord
  positions: AlpacaSnapshotPositionRecord[]
  openOrders: AlpacaSnapshotOrderRecord[]
}

export interface AlpacaAccountSnapshotRecord {
  type: 'account-snapshot'
  accountId: string
  ts: string
  reason: SnapshotReason
  marketClock: MarketClockState | null
  account: AlpacaSnapshotAccountRecord
  positions: AlpacaSnapshotPositionRecord[]
  openOrders: AlpacaSnapshotOrderRecord[]
  evaluation: AlpacaEvaluationViewRecord
}

export interface AlpacaEvalStatus {
  enabled: boolean
  running: boolean
  accountId: string
  feed: 'iex' | 'sip'
  symbols: string[]
  excludedSymbols: string[]
  sampleIntervalMs: number
  accountSnapshotIntervalMs: number
  onlyWhenMarketOpen: boolean
  marketDataConnected: boolean
  tradeUpdatesConnected: boolean
  marketDataAuthenticated: boolean
  tradeUpdatesAuthenticated: boolean
  lastMarketDataMessageAt: string | null
  lastTradeUpdateAt: string | null
  lastSampleAt: string | null
  lastAccountSnapshotAt: string | null
  lastMarketClockAt: string | null
  samplesWritten: number
  tradeUpdatesWritten: number
  accountSnapshotsWritten: number
  marketDataReconnects: number
  tradeUpdatesReconnects: number
  lastError: string | null
}

export interface AlpacaEvalSampler {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): AlpacaEvalStatus
  recentMarketSeconds(limit?: number): AlpacaMarketSecondRecord[]
  recentTradeUpdates(limit?: number): AlpacaTradeUpdateRecord[]
  recentAccountSnapshots(limit?: number): AlpacaAccountSnapshotRecord[]
}

export interface AlpacaEvalCollectorOptions {
  config: AlpacaEvalConfig
  account: UnifiedTradingAccount | null
  apiKey?: string
  apiSecret?: string
  eventLog: EventLog
}

const MAX_RECENT_ITEMS = 300
const MAX_RECONNECT_DELAY_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : null
  return parsed != null && Number.isFinite(parsed) ? parsed : null
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase()
}

function uniqueSymbols(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeSymbol).filter(Boolean)))
}

function clampRecent<T>(items: T[], next: T): T[] {
  const updated = [...items, next]
  if (updated.length <= MAX_RECENT_ITEMS) return updated
  return updated.slice(updated.length - MAX_RECENT_ITEMS)
}

function currentIso(): string {
  return new Date().toISOString()
}

function dateKeyForTimezone(ts: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ts)

  const year = parts.find((part) => part.type === 'year')?.value ?? '0000'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  const day = parts.find((part) => part.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}

async function appendJsonlRecord(baseDir: string, category: string, timezone: string, record: unknown): Promise<void> {
  const now = new Date()
  const dateKey = dateKeyForTimezone(now, timezone)
  const filePath = join(baseDir, category, `${dateKey}.jsonl`)
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

export function normalizeWsPayload(raw: RawData): unknown[] {
  const text = typeof raw === 'string'
    ? raw
    : Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(raw).toString('utf8')
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

export function buildMarketDataStreamUrl(feed: 'iex' | 'sip', override?: string): string {
  return override ?? `wss://stream.data.alpaca.markets/v2/${feed}`
}

export function buildTradingStreamUrl(override?: string): string {
  return override ?? 'wss://paper-api.alpaca.markets/stream'
}

function quoteStateFromRecord(record?: SymbolState): AlpacaMarketSecondSymbolRecord {
  const bid = record?.quote.bid ?? null
  const ask = record?.quote.ask ?? null
  return {
    bid,
    ask,
    spread: bid != null && ask != null ? ask - bid : null,
    bidSize: record?.quote.bidSize ?? null,
    askSize: record?.quote.askSize ?? null,
    bidExchange: record?.quote.bidExchange ?? null,
    askExchange: record?.quote.askExchange ?? null,
    quoteTimestamp: record?.quote.timestamp ?? null,
    last: record?.trade.price ?? null,
    lastSize: record?.trade.size ?? null,
    tradeExchange: record?.trade.exchange ?? null,
    tradeConditions: record?.trade.conditions ?? [],
    tape: record?.trade.tape ?? null,
    tradeTimestamp: record?.trade.timestamp ?? null,
  }
}

export function buildMarketSecondRecord(opts: {
  accountId: string
  feed: 'iex' | 'sip'
  sampleTs?: string
  symbols: string[]
  marketClock: MarketClockState | null
  symbolStates: Map<string, SymbolState>
}): AlpacaMarketSecondRecord {
  const symbols = Object.fromEntries(
    opts.symbols.map((symbol) => [symbol, quoteStateFromRecord(opts.symbolStates.get(symbol))]),
  )
  return {
    type: 'market-second',
    accountId: opts.accountId,
    feed: opts.feed,
    sampleTs: opts.sampleTs ?? currentIso(),
    marketClock: opts.marketClock,
    symbols,
  }
}

function serializeMarketClock(clock: MarketClock | null): MarketClockState | null {
  if (!clock) return null
  return {
    isOpen: clock.isOpen,
    nextOpen: clock.nextOpen.toISOString(),
    nextClose: clock.nextClose.toISOString(),
    timestamp: clock.timestamp.toISOString(),
  }
}

function serializeAccount(account: AccountInfo): AlpacaSnapshotAccountRecord {
  return {
    netLiquidation: account.netLiquidation,
    totalCashValue: account.totalCashValue,
    unrealizedPnL: account.unrealizedPnL,
    realizedPnL: account.realizedPnL,
    ...(account.buyingPower != null ? { buyingPower: account.buyingPower } : {}),
    ...(account.dayTradesRemaining != null ? { dayTradesRemaining: account.dayTradesRemaining } : {}),
  }
}

function serializePositions(positions: Position[]): AlpacaSnapshotPositionRecord[] {
  return positions.map((position) => ({
    symbol: position.contract.symbol,
    side: position.side,
    quantity: position.quantity.toString(),
    avgCost: position.avgCost,
    marketPrice: position.marketPrice,
    marketValue: position.marketValue,
    unrealizedPnL: position.unrealizedPnL,
    realizedPnL: position.realizedPnL,
    leverage: position.leverage,
  }))
}

function serializeOrders(orders: OpenOrder[]): AlpacaSnapshotOrderRecord[] {
  return orders.map((openOrder) => ({
    symbol: openOrder.contract.symbol,
    side: openOrder.order.action,
    quantity: openOrder.order.totalQuantity.toString(),
    orderType: openOrder.order.orderType,
    timeInForce: openOrder.order.tif,
    limitPrice: Number.isFinite(openOrder.order.lmtPrice) ? openOrder.order.lmtPrice : null,
    stopPrice: Number.isFinite(openOrder.order.auxPrice) ? openOrder.order.auxPrice : null,
    status: openOrder.orderState.status,
    warningText: openOrder.orderState.warningText ?? null,
  }))
}

export function buildEvaluationView(opts: {
  account: AlpacaSnapshotAccountRecord
  positions: AlpacaSnapshotPositionRecord[]
  openOrders: AlpacaSnapshotOrderRecord[]
  excludedSymbols: string[]
}): AlpacaEvaluationViewRecord {
  const excludedSymbols = uniqueSymbols(opts.excludedSymbols)
  const excludedSymbolSet = new Set(excludedSymbols)
  const includedPositions = opts.positions.filter((position) => !excludedSymbolSet.has(normalizeSymbol(position.symbol)))
  const excludedPositions = opts.positions.filter((position) => excludedSymbolSet.has(normalizeSymbol(position.symbol)))
  const includedOrders = opts.openOrders.filter((order) => !excludedSymbolSet.has(normalizeSymbol(order.symbol)))
  const excludedOrders = opts.openOrders.filter((order) => excludedSymbolSet.has(normalizeSymbol(order.symbol)))
  const excludedMarketValue = excludedPositions.reduce((sum, position) => sum + position.marketValue, 0)
  const excludedUnrealizedPnL = excludedPositions.reduce((sum, position) => sum + position.unrealizedPnL, 0)

  return {
    excludedSymbols,
    excludedPositionCount: excludedPositions.length,
    excludedOrderCount: excludedOrders.length,
    excludedMarketValue,
    excludedUnrealizedPnL,
    account: {
      ...opts.account,
      netLiquidation: opts.account.netLiquidation - excludedMarketValue,
      unrealizedPnL: opts.account.unrealizedPnL - excludedUnrealizedPnL,
    },
    positions: includedPositions,
    openOrders: includedOrders,
  }
}

function summarizeTradeUpdate(accountId: string, payload: Record<string, unknown>): AlpacaTradeUpdateRecord {
  const event = toStringOrNull(payload.event) ?? 'unknown'
  const order = isRecord(payload.order) ? payload.order : {}
  const ts =
    toStringOrNull(payload.timestamp) ??
    toStringOrNull(order.updated_at) ??
    toStringOrNull(order.filled_at) ??
    currentIso()
  return {
    type: 'trade-update',
    accountId,
    ts,
    event,
    orderId: toStringOrNull(order.id),
    clientOrderId: toStringOrNull(order.client_order_id),
    symbol: toStringOrNull(order.symbol),
    side: toStringOrNull(order.side),
    status: toStringOrNull(order.status),
    qty: toStringOrNull(order.qty),
    filledQty: toStringOrNull(order.filled_qty),
    filledAvgPrice: toStringOrNull(order.filled_avg_price),
    raw: payload,
  }
}

export class AlpacaEvalCollector implements AlpacaEvalSampler {
  private readonly config: AlpacaEvalConfig
  private readonly account: UnifiedTradingAccount | null
  private readonly apiKey?: string
  private readonly apiSecret?: string
  private readonly eventLog: EventLog

  private marketDataSocket: WebSocket | null = null
  private tradingSocket: WebSocket | null = null
  private running = false
  private marketDataConnected = false
  private tradeUpdatesConnected = false
  private marketDataAuthenticated = false
  private tradeUpdatesAuthenticated = false
  private lastMarketDataMessageAt: string | null = null
  private lastTradeUpdateAt: string | null = null
  private lastSampleAt: string | null = null
  private lastAccountSnapshotAt: string | null = null
  private lastMarketClockAt: string | null = null
  private lastError: string | null = null
  private marketDataReconnects = 0
  private tradeUpdatesReconnects = 0
  private samplesWritten = 0
  private tradeUpdatesWritten = 0
  private accountSnapshotsWritten = 0
  private sampleTimer: NodeJS.Timeout | null = null
  private accountTimer: NodeJS.Timeout | null = null
  private marketClockTimer: NodeJS.Timeout | null = null
  private marketReconnectTimer: NodeJS.Timeout | null = null
  private tradeReconnectTimer: NodeJS.Timeout | null = null
  private accountSnapshotInFlight = false
  private marketClockInFlight = false
  private marketClock: MarketClock | null = null
  private symbolStates = new Map<string, SymbolState>()
  private recentMarketSecondRecords: AlpacaMarketSecondRecord[] = []
  private recentTradeUpdateRecords: AlpacaTradeUpdateRecord[] = []
  private recentAccountSnapshotRecords: AlpacaAccountSnapshotRecord[] = []

  constructor(opts: AlpacaEvalCollectorOptions) {
    this.config = opts.config
    this.account = opts.account
    this.apiKey = opts.apiKey
    this.apiSecret = opts.apiSecret
    this.eventLog = opts.eventLog
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.running) return

    if (!this.account) {
      this.lastError = `Alpaca evaluation account "${this.config.accountId}" is not available`
      await this.eventLog.append('alpaca-eval.error', { message: this.lastError })
      return
    }

    if (!this.apiKey || !this.apiSecret) {
      this.lastError = `Missing Alpaca credentials for "${this.config.accountId}"`
      await this.eventLog.append('alpaca-eval.error', { message: this.lastError })
      return
    }

    if (this.config.symbols.length === 0) {
      this.lastError = 'Alpaca evaluation requires at least one symbol'
      await this.eventLog.append('alpaca-eval.error', { message: this.lastError })
      return
    }

    this.running = true
    await mkdir(this.config.dataDir, { recursive: true })
    await this.eventLog.append('alpaca-eval.started', {
      accountId: this.config.accountId,
      symbols: this.config.symbols,
      feed: this.config.marketDataFeed,
      sampleIntervalMs: this.config.sampleIntervalMs,
      accountSnapshotIntervalMs: this.config.accountSnapshotIntervalMs,
    })

    await this.refreshMarketClock()
    await this.captureAccountSnapshot('startup')
    this.connectMarketDataStream()
    this.connectTradingStream()

    this.sampleTimer = setInterval(() => {
      void this.flushMarketSecond()
    }, this.config.sampleIntervalMs)

    this.accountTimer = setInterval(() => {
      void this.captureAccountSnapshot('interval')
    }, this.config.accountSnapshotIntervalMs)

    this.marketClockTimer = setInterval(() => {
      void this.refreshMarketClock()
    }, this.config.marketClockIntervalMs)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    if (this.sampleTimer) clearInterval(this.sampleTimer)
    if (this.accountTimer) clearInterval(this.accountTimer)
    if (this.marketClockTimer) clearInterval(this.marketClockTimer)
    if (this.marketReconnectTimer) clearTimeout(this.marketReconnectTimer)
    if (this.tradeReconnectTimer) clearTimeout(this.tradeReconnectTimer)

    this.marketDataSocket?.close()
    this.tradingSocket?.close()

    this.sampleTimer = null
    this.accountTimer = null
    this.marketClockTimer = null
    this.marketReconnectTimer = null
    this.tradeReconnectTimer = null
    this.marketDataSocket = null
    this.tradingSocket = null

    await this.eventLog.append('alpaca-eval.stopped', {
      accountId: this.config.accountId,
      samplesWritten: this.samplesWritten,
      tradeUpdatesWritten: this.tradeUpdatesWritten,
      accountSnapshotsWritten: this.accountSnapshotsWritten,
    })
  }

  getStatus(): AlpacaEvalStatus {
    return {
      enabled: this.config.enabled,
      running: this.running,
      accountId: this.config.accountId,
      feed: this.config.marketDataFeed,
      symbols: this.config.symbols,
      excludedSymbols: uniqueSymbols(this.config.excludedSymbols),
      sampleIntervalMs: this.config.sampleIntervalMs,
      accountSnapshotIntervalMs: this.config.accountSnapshotIntervalMs,
      onlyWhenMarketOpen: this.config.onlyWhenMarketOpen,
      marketDataConnected: this.marketDataConnected,
      tradeUpdatesConnected: this.tradeUpdatesConnected,
      marketDataAuthenticated: this.marketDataAuthenticated,
      tradeUpdatesAuthenticated: this.tradeUpdatesAuthenticated,
      lastMarketDataMessageAt: this.lastMarketDataMessageAt,
      lastTradeUpdateAt: this.lastTradeUpdateAt,
      lastSampleAt: this.lastSampleAt,
      lastAccountSnapshotAt: this.lastAccountSnapshotAt,
      lastMarketClockAt: this.lastMarketClockAt,
      samplesWritten: this.samplesWritten,
      tradeUpdatesWritten: this.tradeUpdatesWritten,
      accountSnapshotsWritten: this.accountSnapshotsWritten,
      marketDataReconnects: this.marketDataReconnects,
      tradeUpdatesReconnects: this.tradeUpdatesReconnects,
      lastError: this.lastError,
    }
  }

  recentMarketSeconds(limit = 60): AlpacaMarketSecondRecord[] {
    return this.recentMarketSecondRecords.slice(-limit)
  }

  recentTradeUpdates(limit = 60): AlpacaTradeUpdateRecord[] {
    return this.recentTradeUpdateRecords.slice(-limit)
  }

  recentAccountSnapshots(limit = 60): AlpacaAccountSnapshotRecord[] {
    return this.recentAccountSnapshotRecords.slice(-limit)
  }

  private connectMarketDataStream(): void {
    if (!this.running || !this.apiKey || !this.apiSecret) return

    const url = buildMarketDataStreamUrl(this.config.marketDataFeed, this.config.marketDataStreamUrl)
    const socket = new WebSocket(url)
    this.marketDataSocket = socket
    this.marketDataConnected = false
    this.marketDataAuthenticated = false

    socket.on('open', () => {
      socket.send(JSON.stringify({
        action: 'auth',
        key: this.apiKey,
        secret: this.apiSecret,
      }))
    })

    socket.on('message', (raw) => {
      try {
        const payloads = normalizeWsPayload(raw)
        for (const payload of payloads) {
          this.handleMarketDataMessage(payload, socket)
        }
      } catch (err) {
        this.recordError(`alpaca market data payload error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    socket.on('close', () => {
      this.marketDataConnected = false
      this.marketDataAuthenticated = false
      if (!this.running) return
      this.marketDataReconnects += 1
      this.scheduleMarketReconnect()
    })

    socket.on('error', (err) => {
      this.recordError(`alpaca market data socket error: ${err.message}`)
    })
  }

  private connectTradingStream(): void {
    if (!this.running || !this.apiKey || !this.apiSecret || !this.config.recordTradeUpdates) return

    const url = buildTradingStreamUrl(this.config.tradingStreamUrl)
    const socket = new WebSocket(url)
    this.tradingSocket = socket
    this.tradeUpdatesConnected = false
    this.tradeUpdatesAuthenticated = false

    socket.on('open', () => {
      socket.send(JSON.stringify({
        action: 'authenticate',
        data: {
          key_id: this.apiKey,
          secret_key: this.apiSecret,
        },
      }))
    })

    socket.on('message', (raw) => {
      try {
        const payloads = normalizeWsPayload(raw)
        for (const payload of payloads) {
          this.handleTradingMessage(payload, socket)
        }
      } catch (err) {
        this.recordError(`alpaca trade update payload error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    socket.on('close', () => {
      this.tradeUpdatesConnected = false
      this.tradeUpdatesAuthenticated = false
      if (!this.running) return
      this.tradeUpdatesReconnects += 1
      this.scheduleTradeReconnect()
    })

    socket.on('error', (err) => {
      this.recordError(`alpaca trade update socket error: ${err.message}`)
    })
  }

  private handleMarketDataMessage(payload: unknown, socket: WebSocket): void {
    if (!isRecord(payload)) return
    const messageType = toStringOrNull(payload.T) ?? toStringOrNull(payload.stream)
    if (!messageType) return

    if (messageType === 'success') {
      const msg = toStringOrNull(payload.msg)
      if (msg === 'connected') {
        this.marketDataConnected = true
        void this.eventLog.append('alpaca-eval.market-data.connected', {
          accountId: this.config.accountId,
          url: buildMarketDataStreamUrl(this.config.marketDataFeed, this.config.marketDataStreamUrl),
        })
      } else if (msg === 'authenticated') {
        this.marketDataAuthenticated = true
        socket.send(JSON.stringify({
          action: 'subscribe',
          ...(this.config.recordQuotes ? { quotes: this.config.symbols } : {}),
          ...(this.config.recordTrades ? { trades: this.config.symbols } : {}),
        }))
        void this.eventLog.append('alpaca-eval.market-data.authenticated', {
          accountId: this.config.accountId,
          symbols: this.config.symbols,
          feed: this.config.marketDataFeed,
        })
      }
      return
    }

    if (messageType === 'subscription') {
      return
    }

    const symbol = toStringOrNull(payload.S)
    if (!symbol || !this.config.symbols.includes(symbol)) return

    const state = this.symbolStates.get(symbol) ?? {
      quote: {
        bid: null,
        ask: null,
        bidSize: null,
        askSize: null,
        bidExchange: null,
        askExchange: null,
        timestamp: null,
      },
      trade: {
        price: null,
        size: null,
        exchange: null,
        conditions: [],
        tape: null,
        timestamp: null,
      },
    }

    if (messageType === 'q' || messageType === 'quote') {
      state.quote.bid = toNumber(payload.bp)
      state.quote.ask = toNumber(payload.ap)
      state.quote.bidSize = toNumber(payload.bs)
      state.quote.askSize = toNumber(payload.as)
      state.quote.bidExchange = toStringOrNull(payload.bx)
      state.quote.askExchange = toStringOrNull(payload.ax)
      state.quote.timestamp = toStringOrNull(payload.t)
      this.lastMarketDataMessageAt = currentIso()
    }

    if (messageType === 't' || messageType === 'trade') {
      state.trade.price = toNumber(payload.p)
      state.trade.size = toNumber(payload.s)
      state.trade.exchange = toStringOrNull(payload.x)
      state.trade.conditions = Array.isArray(payload.c)
        ? payload.c.filter((item): item is string => typeof item === 'string')
        : []
      state.trade.tape = toStringOrNull(payload.z)
      state.trade.timestamp = toStringOrNull(payload.t)
      this.lastMarketDataMessageAt = currentIso()
    }

    this.symbolStates.set(symbol, state)
  }

  private handleTradingMessage(payload: unknown, socket: WebSocket): void {
    if (!isRecord(payload)) return

    const stream = toStringOrNull(payload.stream)
    if (stream === 'authorization') {
      const data = isRecord(payload.data) ? payload.data : {}
      const status = toStringOrNull(data.status)
      if (status === 'authorized') {
        this.tradeUpdatesConnected = true
        this.tradeUpdatesAuthenticated = true
        socket.send(JSON.stringify({
          action: 'listen',
          data: { streams: ['trade_updates'] },
        }))
        void this.eventLog.append('alpaca-eval.trade-stream.authenticated', {
          accountId: this.config.accountId,
          url: buildTradingStreamUrl(this.config.tradingStreamUrl),
        })
      }
      return
    }

    if (stream === 'listening') {
      this.tradeUpdatesConnected = true
      return
    }

    if (stream !== 'trade_updates') return

    const data = isRecord(payload.data) ? payload.data : {}
    const record = summarizeTradeUpdate(this.config.accountId, data)
    this.lastTradeUpdateAt = record.ts
    this.tradeUpdatesWritten += 1
    this.recentTradeUpdateRecords = clampRecent(this.recentTradeUpdateRecords, record)
    void appendJsonlRecord(this.config.dataDir, 'trade-updates', this.config.timezone, record)
    void this.eventLog.append('alpaca-eval.trade-update', {
      accountId: this.config.accountId,
      event: record.event,
      orderId: record.orderId,
      symbol: record.symbol,
      status: record.status,
      filledQty: record.filledQty,
      filledAvgPrice: record.filledAvgPrice,
    })
    void this.captureAccountSnapshot('trade-update')
  }

  private scheduleMarketReconnect(): void {
    if (!this.running) return
    if (this.marketReconnectTimer) clearTimeout(this.marketReconnectTimer)
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.max(0, this.marketDataReconnects - 1))
    this.marketReconnectTimer = setTimeout(() => {
      this.connectMarketDataStream()
    }, delay)
    void this.eventLog.append('alpaca-eval.market-data.reconnect-scheduled', {
      accountId: this.config.accountId,
      delayMs: delay,
      attempt: this.marketDataReconnects,
    })
  }

  private scheduleTradeReconnect(): void {
    if (!this.running || !this.config.recordTradeUpdates) return
    if (this.tradeReconnectTimer) clearTimeout(this.tradeReconnectTimer)
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.max(0, this.tradeUpdatesReconnects - 1))
    this.tradeReconnectTimer = setTimeout(() => {
      this.connectTradingStream()
    }, delay)
    void this.eventLog.append('alpaca-eval.trade-stream.reconnect-scheduled', {
      accountId: this.config.accountId,
      delayMs: delay,
      attempt: this.tradeUpdatesReconnects,
    })
  }

  private async flushMarketSecond(): Promise<void> {
    if (!this.running) return
    if (this.config.onlyWhenMarketOpen && this.marketClock && !this.marketClock.isOpen) return

    const record = buildMarketSecondRecord({
      accountId: this.config.accountId,
      feed: this.config.marketDataFeed,
      symbols: this.config.symbols,
      marketClock: serializeMarketClock(this.marketClock),
      symbolStates: this.symbolStates,
    })

    await appendJsonlRecord(this.config.dataDir, 'market-seconds', this.config.timezone, record)
    this.samplesWritten += 1
    this.lastSampleAt = record.sampleTs
    this.recentMarketSecondRecords = clampRecent(this.recentMarketSecondRecords, record)
  }

  private async captureAccountSnapshot(reason: SnapshotReason): Promise<void> {
    if (!this.running || !this.account || this.accountSnapshotInFlight) return
    if (reason === 'interval' && this.config.onlyWhenMarketOpen && this.marketClock && !this.marketClock.isOpen) {
      return
    }

    this.accountSnapshotInFlight = true
    try {
      const pendingOrderIds = this.account.getPendingOrderIds().map((item) => item.orderId)
      const [account, positions, openOrders] = await Promise.all([
        this.account.getAccount(),
        this.account.getPositions(),
        this.account.getOrders(pendingOrderIds),
      ])
      const serializedAccount = serializeAccount(account)
      const serializedPositions = serializePositions(positions)
      const serializedOrders = serializeOrders(openOrders)

      const record: AlpacaAccountSnapshotRecord = {
        type: 'account-snapshot',
        accountId: this.config.accountId,
        ts: currentIso(),
        reason,
        marketClock: serializeMarketClock(this.marketClock),
        account: serializedAccount,
        positions: serializedPositions,
        openOrders: serializedOrders,
        evaluation: buildEvaluationView({
          account: serializedAccount,
          positions: serializedPositions,
          openOrders: serializedOrders,
          excludedSymbols: this.config.excludedSymbols,
        }),
      }

      await appendJsonlRecord(this.config.dataDir, 'account-snapshots', this.config.timezone, record)
      this.accountSnapshotsWritten += 1
      this.lastAccountSnapshotAt = record.ts
      this.recentAccountSnapshotRecords = clampRecent(this.recentAccountSnapshotRecords, record)
    } catch (err) {
      this.recordError(`alpaca account snapshot error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.accountSnapshotInFlight = false
    }
  }

  private async refreshMarketClock(): Promise<void> {
    if (!this.running || !this.account || this.marketClockInFlight) return
    this.marketClockInFlight = true
    try {
      if (this.account.getMarketClock) {
        this.marketClock = await this.account.getMarketClock()
        this.lastMarketClockAt = currentIso()
      }
    } catch (err) {
      this.recordError(`alpaca market clock error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.marketClockInFlight = false
    }
  }

  private recordError(message: string): void {
    this.lastError = message
    void this.eventLog.append('alpaca-eval.error', {
      accountId: this.config.accountId,
      message,
    })
  }
}
