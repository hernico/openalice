/**
 * RequestBridge — callback→Promise bridging layer for IBKR TWS API.
 *
 * Extends DefaultEWrapper to intercept TWS callbacks and route them
 * to pending Promises. Three routing modes:
 *
 * A) reqId-based: symbolSamples, contractDetails, accountSummary, tickSnapshot
 * B) orderId-based: openOrder, orderStatus (for placeOrder/cancelOrder)
 * C) Single-slot: accountDownload (updatePortfolio/updateAccountValue), openOrders batch
 */

import Decimal from 'decimal.js'
import {
  DefaultEWrapper,
  NO_VALID_ID,
  TickTypeEnum,
  Contract as ContractClass,
  Order as OrderClass,
  OrderState as OrderStateClass,
  type Contract,
  type ContractDescription,
  type ContractDetails,
  type Order,
  type OrderState,
  type EClient,
  type TickAttrib,
} from '@traderalice/ibkr'
import { BrokerError } from '../types.js'
import { classifyIbkrError } from './ibkr-contracts.js'
import type {
  PendingRequest,
  TickSnapshot,
  AccountDownloadResult,
  CollectedOpenOrder,
} from './ibkr-types.js'

const DEFAULT_TIMEOUT_MS = 10_000
const ACCOUNT_DOWNLOAD_TIMEOUT_MS = 20_000

export class RequestBridge extends DefaultEWrapper {
  // ---- State ----
  private nextReqId_ = 10_000
  private nextOrderId_ = 0
  private accountId_: string | null = null
  private client_: EClient | null = null

  // ---- Mode A: reqId-based pending requests ----
  private pending = new Map<number, PendingRequest>()
  private collectors = new Map<number, unknown[]>()

  // ---- Mode A: tick snapshot accumulators ----
  private snapshots = new Map<number, TickSnapshot>()

  // ---- Mode B: orderId-based pending requests ----
  private orderPending = new Map<number, PendingRequest<CollectedOpenOrder>>()

  // ---- Mode C: single-slot collectors ----
  private accountDownload: {
    positions: Array<{
      contract: Contract
      side: 'long' | 'short'
      quantity: Decimal
      avgCost: number
      marketPrice: number
      marketValue: number
      unrealizedPnL: number
      realizedPnL: number
    }>
    values: Map<string, string>
    resolve: (result: AccountDownloadResult) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private accountDownloadLock: Promise<AccountDownloadResult> | null = null

  private openOrdersCollector: {
    orders: CollectedOpenOrder[]
    resolve: (orders: CollectedOpenOrder[]) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  // ---- Connection handshake ----
  private connectResolve: (() => void) | null = null
  private connectReject: ((err: Error) => void) | null = null

  // ---- Current time request ----
  private currentTimePending: PendingRequest<number> | null = null

  // ==================== Public API ====================

  /** Store reference to the EClient for unsubscribe calls. */
  setClient(client: EClient): void {
    this.client_ = client
  }

  /** Allocate a unique reqId (starts at 10000 to avoid orderId range). */
  allocReqId(): number {
    return this.nextReqId_++
  }

  /** Get and increment the next valid order ID. */
  getNextOrderId(): number {
    return this.nextOrderId_++
  }

  /** Get the auto-detected account ID from managedAccounts callback. */
  getAccountId(): string | null {
    return this.accountId_
  }

  // ---- Connection ----

  /** Connect the EClient and wait for nextValidId (indicates TWS is ready). */
  async waitForConnect(
    client: EClient,
    host: string,
    port: number,
    clientId: number,
    timeoutMs = 15_000,
  ): Promise<void> {
    this.client_ = client

    const promise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      setTimeout(() => {
        this.connectResolve = null
        this.connectReject = null
        reject(new BrokerError('NETWORK', `Connection to TWS/Gateway timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    await client.connect(host, port, clientId)
    return promise
  }

  // ---- Mode A: reqId-based requests ----

  /** Register a pending request that resolves with a single value. */
  request<T>(reqId: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new BrokerError('NETWORK', `Request ${reqId} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer })
    })
  }

  /** Register a pending request that collects multiple callbacks into an array. */
  requestCollector<T>(reqId: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T[]> {
    this.collectors.set(reqId, [])
    return this.request<T[]>(reqId, timeoutMs)
  }

  /** Register a snapshot market data request. */
  requestSnapshot(reqId: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TickSnapshot> {
    this.snapshots.set(reqId, {})
    return this.request<TickSnapshot>(reqId, timeoutMs)
  }

  // ---- Mode B: orderId-based requests ----

  /** Register a pending order request (waits for openOrder callback). */
  requestOrder(orderId: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CollectedOpenOrder> {
    return new Promise<CollectedOpenOrder>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.orderPending.delete(orderId)
        reject(new BrokerError('NETWORK', `Order ${orderId} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.orderPending.set(orderId, { resolve, reject, timer })
    })
  }

  // ---- Mode C: single-slot requests ----

  /** Request account download (positions + account values). Serial access via lock. */
  async requestAccountDownload(acctCode: string, timeoutMs = ACCOUNT_DOWNLOAD_TIMEOUT_MS): Promise<AccountDownloadResult> {
    // Queue behind any in-flight download
    if (this.accountDownloadLock) {
      await this.accountDownloadLock.catch(() => {})
    }

    const promise = new Promise<AccountDownloadResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.accountDownload = null
        this.client_?.reqAccountUpdates(false, acctCode)
        reject(new BrokerError('NETWORK', `Account download timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.accountDownload = {
        positions: [],
        values: new Map(),
        resolve,
        reject,
        timer,
      }
    })

    this.accountDownloadLock = promise.finally(() => {
      this.accountDownloadLock = null
    })

    this.client_!.reqAccountUpdates(true, acctCode)
    return promise
  }

  /** Request all open orders (batch collector). */
  requestOpenOrders(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CollectedOpenOrder[]> {
    return new Promise<CollectedOpenOrder[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openOrdersCollector = null
        reject(new BrokerError('NETWORK', `Open orders request timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.openOrdersCollector = { orders: [], resolve, reject, timer }
      this.client_!.reqOpenOrders()
    })
  }

  /** Request current TWS server time. */
  requestCurrentTime(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.currentTimePending = null
        reject(new BrokerError('NETWORK', `currentTime request timed out`))
      }, timeoutMs)

      this.currentTimePending = { resolve: resolve as (v: unknown) => void, reject, timer }
      this.client_!.reqCurrentTime()
    })
  }

  // ==================== Internal helpers ====================

  private resolveRequest(reqId: number, value: unknown): void {
    const entry = this.pending.get(reqId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(reqId)
    this.collectors.delete(reqId)
    this.snapshots.delete(reqId)
    entry.resolve(value)
  }

  private rejectRequest(reqId: number, error: Error): void {
    const entry = this.pending.get(reqId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(reqId)
    this.collectors.delete(reqId)
    this.snapshots.delete(reqId)
    entry.reject(error)
  }

  private pushCollector(reqId: number, item: unknown): void {
    this.collectors.get(reqId)?.push(item)
  }

  private resolveCollector(reqId: number): void {
    this.resolveRequest(reqId, this.collectors.get(reqId) ?? [])
  }

  private resolveOrderRequest(orderId: number, value: CollectedOpenOrder): void {
    const entry = this.orderPending.get(orderId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.orderPending.delete(orderId)
    entry.resolve(value)
  }

  private rejectOrderRequest(orderId: number, error: Error): void {
    const entry = this.orderPending.get(orderId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.orderPending.delete(orderId)
    entry.reject(error)
  }

  private rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    this.collectors.clear()
    this.snapshots.clear()

    for (const [, entry] of this.orderPending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.orderPending.clear()

    if (this.accountDownload) {
      clearTimeout(this.accountDownload.timer)
      this.accountDownload.reject(error)
      this.accountDownload = null
    }

    if (this.openOrdersCollector) {
      clearTimeout(this.openOrdersCollector.timer)
      this.openOrdersCollector.reject(error)
      this.openOrdersCollector = null
    }

    if (this.currentTimePending) {
      clearTimeout(this.currentTimePending.timer)
      this.currentTimePending.reject(error)
      this.currentTimePending = null
    }
  }

  // ==================== EWrapper callback overrides ====================

  // ---- Connection ----

  override nextValidId(orderId: number): void {
    this.nextOrderId_ = orderId
    // Resolve the connect promise (TWS is ready)
    if (this.connectResolve) {
      this.connectResolve()
      this.connectResolve = null
      this.connectReject = null
    }
  }

  override managedAccounts(accountsList: string): void {
    const accounts = accountsList.split(',').map(s => s.trim()).filter(Boolean)
    this.accountId_ = accounts[0] ?? null
  }

  override connectionClosed(): void {
    this.rejectAll(new BrokerError('NETWORK', 'Connection to TWS/Gateway lost'))

    if (this.connectReject) {
      this.connectReject(new BrokerError('NETWORK', 'Connection to TWS/Gateway closed during handshake'))
      this.connectResolve = null
      this.connectReject = null
    }
  }

  // ---- Error routing ----

  override error(reqId: number, _errorTime: number, errorCode: number, errorString: string): void {
    // Informational messages (code >= 2000) — data farm status, etc.
    if (errorCode >= 2000) return

    // System-level errors (reqId === -1) — connectivity events
    if (reqId === NO_VALID_ID) {
      if (errorCode === 502 || errorCode === 504 || errorCode === 1100) {
        // These will be followed by connectionClosed() which rejects all
      }
      return
    }

    // Request-specific errors — reject the corresponding pending Promise
    const brokerError = classifyIbkrError(errorCode, errorString)

    // Try reqId-based first, then orderId-based
    if (this.pending.has(reqId)) {
      this.rejectRequest(reqId, brokerError)
    } else if (this.orderPending.has(reqId)) {
      this.rejectOrderRequest(reqId, brokerError)
    }
  }

  // ---- Contract search (symbolSamples) ----

  override symbolSamples(_reqId: number, contractDescriptions: ContractDescription[]): void {
    this.resolveRequest(_reqId, contractDescriptions)
  }

  // ---- Contract details (collector) ----

  override contractDetails(reqId: number, cd: ContractDetails): void {
    this.pushCollector(reqId, cd)
  }

  override contractDetailsEnd(reqId: number): void {
    this.resolveCollector(reqId)
  }

  // ---- Account summary (collector using Map) ----

  override accountSummary(reqId: number, _account: string, tag: string, value: string, _currency: string): void {
    // For accountSummary we use the collectors map but store a Map<string,string>
    let map = this.collectors.get(reqId) as unknown as Map<string, string> | undefined
    if (!map) {
      map = new Map()
      this.collectors.set(reqId, map as unknown as unknown[])
    }
    map.set(tag, value)
  }

  override accountSummaryEnd(reqId: number): void {
    // Resolve with the Map (stored in collectors slot)
    this.resolveRequest(reqId, this.collectors.get(reqId) ?? new Map<string, string>())
  }

  // ---- Account download (updatePortfolio + updateAccountValue) ----

  override updatePortfolio(
    contract: Contract,
    position: Decimal,
    marketPrice: number,
    marketValue: number,
    averageCost: number,
    unrealizedPNL: number,
    realizedPNL: number,
    _accountName: string,
  ): void {
    if (!this.accountDownload) return
    if (position.isZero()) return // no position

    this.accountDownload.positions.push({
      contract,
      side: position.greaterThan(0) ? 'long' : 'short',
      quantity: position.abs(),
      avgCost: averageCost,
      marketPrice,
      marketValue: Math.abs(marketValue),
      unrealizedPnL: unrealizedPNL,
      realizedPnL: realizedPNL,
    })
  }

  override updateAccountValue(key: string, val: string, _currency: string, _accountName: string): void {
    this.accountDownload?.values.set(key, val)
  }

  override accountDownloadEnd(_accountName: string): void {
    if (!this.accountDownload) return
    clearTimeout(this.accountDownload.timer)

    const result: AccountDownloadResult = {
      values: this.accountDownload.values,
      positions: this.accountDownload.positions,
    }

    this.accountDownload.resolve(result)
    this.accountDownload = null

    // Unsubscribe
    this.client_?.reqAccountUpdates(false, _accountName)
  }

  // ---- Market data snapshot ----

  override tickPrice(reqId: number, tickType: number, price: number, _attrib: TickAttrib): void {
    const snap = this.snapshots.get(reqId)
    if (!snap) return

    switch (tickType) {
      case TickTypeEnum.BID: snap.bid = price; break
      case TickTypeEnum.ASK: snap.ask = price; break
      case TickTypeEnum.LAST: snap.last = price; break
      case TickTypeEnum.HIGH: snap.high = price; break
      case TickTypeEnum.LOW: snap.low = price; break
    }
  }

  override tickSize(reqId: number, tickType: number, size: Decimal): void {
    const snap = this.snapshots.get(reqId)
    if (!snap) return

    if (tickType === TickTypeEnum.VOLUME) {
      snap.volume = size.toNumber()
    }
  }

  override tickString(reqId: number, tickType: number, value: string): void {
    const snap = this.snapshots.get(reqId)
    if (!snap) return

    // TickType 45 = LAST_TIMESTAMP
    if (tickType === 45) {
      snap.lastTimestamp = parseInt(value, 10)
    }
  }

  override tickSnapshotEnd(reqId: number): void {
    const snap = this.snapshots.get(reqId) ?? {}
    this.snapshots.delete(reqId)
    this.resolveRequest(reqId, snap)
  }

  // ---- Orders ----

  override openOrder(orderId: number, contract: Contract, order: Order, orderState: OrderState): void {
    const collected: CollectedOpenOrder = { contract, order, orderState }

    // Route to pending order request (placeOrder/modifyOrder)
    if (this.orderPending.has(orderId)) {
      this.resolveOrderRequest(orderId, collected)
    }

    // Also collect for openOrders batch
    this.openOrdersCollector?.orders.push(collected)
  }

  override orderStatus(
    orderId: number,
    status: string,
    _filled: Decimal,
    _remaining: Decimal,
    _avgFillPrice: number,
    _permId: number,
    _parentId: number,
    _lastFillPrice: number,
    _clientId: number,
    _whyHeld: string,
    _mktCapPrice: number,
  ): void {
    // For cancel requests, we wait for status 'Cancelled'
    if (this.orderPending.has(orderId) && status === 'Cancelled') {
      const os = new OrderStateClass()
      os.status = 'Cancelled'
      this.resolveOrderRequest(orderId, {
        contract: new ContractClass(),
        order: new OrderClass(),
        orderState: os,
      })
    }
  }

  override openOrderEnd(): void {
    if (!this.openOrdersCollector) return
    clearTimeout(this.openOrdersCollector.timer)
    this.openOrdersCollector.resolve(this.openOrdersCollector.orders)
    this.openOrdersCollector = null
  }

  // ---- Current time ----

  override currentTime(time: number): void {
    if (!this.currentTimePending) return
    clearTimeout(this.currentTimePending.timer)
    this.currentTimePending.resolve(time)
    this.currentTimePending = null
  }
}
