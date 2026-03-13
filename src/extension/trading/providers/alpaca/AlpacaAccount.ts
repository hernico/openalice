/**
 * AlpacaAccount — ITradingAccount adapter for Alpaca
 *
 * Direct implementation against @alpacahq/alpaca-trade-api SDK.
 * Supports US equities (STK). Contract resolution uses Alpaca's ticker
 * as nativeId — unambiguous for stocks, extensible when options arrive.
 */

import Alpaca from '@alpacahq/alpaca-trade-api'
import type { Contract, ContractDescription, ContractDetails } from '../../contract.js'
import type {
  ITradingAccount,
  AccountCapabilities,
  AccountInfo,
  Position,
  Order,
  OrderRequest,
  OrderResult,
  Quote,
  MarketClock,
} from '../../interfaces.js'
import type {
  AlpacaAccountConfig,
  AlpacaAccountRaw,
  AlpacaPositionRaw,
  AlpacaOrderRaw,
  AlpacaSnapshotRaw,
  AlpacaFillActivityRaw,
  AlpacaClockRaw,
} from './alpaca-types.js'
import { makeContract, resolveSymbol, mapAlpacaOrderStatus } from './alpaca-contracts.js'
import { computeRealizedPnL } from './alpaca-pnl.js'

export class AlpacaAccount implements ITradingAccount {
  readonly id: string
  readonly provider = 'alpaca'
  readonly label: string

  private client!: InstanceType<typeof Alpaca>
  private readonly config: AlpacaAccountConfig

  /** Cached realized PnL from FILL activities (FIFO lot matching) */
  private realizedPnLCache: { value: number; updatedAt: number } | null = null
  private static readonly REALIZED_PNL_TTL_MS = 60_000

  constructor(config: AlpacaAccountConfig) {
    this.config = config
    this.id = config.id ?? (config.paper ? 'alpaca-paper' : 'alpaca-live')
    this.label = config.label ?? (config.paper ? 'Alpaca Paper' : 'Alpaca Live')
  }

  // ---- Lifecycle ----

  private static readonly MAX_INIT_RETRIES = 5
  private static readonly MAX_AUTH_RETRIES = 2
  private static readonly INIT_RETRY_BASE_MS = 1000

  async init(): Promise<void> {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new Error(
        `No API credentials configured. Set apiKey and apiSecret in accounts.json to enable this account.`,
      )
    }

    this.client = new Alpaca({
      keyId: this.config.apiKey,
      secretKey: this.config.secretKey,
      paper: this.config.paper,
    })

    let lastErr: unknown
    for (let attempt = 1; attempt <= AlpacaAccount.MAX_INIT_RETRIES; attempt++) {
      try {
        const account = await this.client.getAccount() as AlpacaAccountRaw
        console.log(
          `AlpacaAccount[${this.id}]: connected (paper=${this.config.paper}, equity=$${parseFloat(account.equity).toFixed(2)})`,
        )
        return
      } catch (err) {
        lastErr = err
        const isAuthError = err instanceof Error &&
          /40[13]|forbidden|unauthorized/i.test(err.message)
        if (isAuthError && attempt >= AlpacaAccount.MAX_AUTH_RETRIES) {
          throw new Error(
            `Authentication failed — verify your Alpaca API key and secret are correct.`,
          )
        }
        if (attempt < AlpacaAccount.MAX_INIT_RETRIES) {
          const delay = AlpacaAccount.INIT_RETRY_BASE_MS * 2 ** (attempt - 1)
          console.warn(`AlpacaAccount[${this.id}]: init attempt ${attempt}/${AlpacaAccount.MAX_INIT_RETRIES} failed, retrying in ${delay}ms...`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }

  async close(): Promise<void> {
    // Alpaca SDK has no explicit close
  }

  // ---- Contract search ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []

    // Alpaca tickers are unique for stocks — pattern is treated as exact ticker match
    const ticker = pattern.toUpperCase()
    return [{ contract: makeContract(ticker, this.provider) }]
  }

  async getContractDetails(query: Partial<Contract>): Promise<ContractDetails | null> {
    const symbol = resolveSymbol(query as Contract, this.provider)
    if (!symbol) return null

    return {
      contract: makeContract(symbol, this.provider),
      validExchanges: ['SMART', 'NYSE', 'NASDAQ', 'ARCA'],
      orderTypes: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'],
      stockType: 'COMMON',
    }
  }

  // ---- Trading operations ----

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const symbol = resolveSymbol(order.contract, this.provider)
    if (!symbol) {
      return { success: false, error: 'Cannot resolve contract to Alpaca symbol' }
    }

    try {
      const alpacaOrder: Record<string, unknown> = {
        symbol,
        side: order.side,
        type: order.type === 'trailing_stop' ? 'trailing_stop' : order.type,
        time_in_force: order.timeInForce ?? 'day',
      }

      if (order.qty != null) {
        alpacaOrder.qty = order.qty
      } else if (order.notional != null) {
        alpacaOrder.notional = order.notional
      }

      if (order.price != null) alpacaOrder.limit_price = order.price
      if (order.stopPrice != null) alpacaOrder.stop_price = order.stopPrice
      if (order.trailingAmount != null) alpacaOrder.trail_price = order.trailingAmount
      if (order.trailingPercent != null) alpacaOrder.trail_percent = order.trailingPercent
      if (order.extendedHours != null) alpacaOrder.extended_hours = order.extendedHours

      const result = await this.client.createOrder(alpacaOrder) as AlpacaOrderRaw
      const isFilled = result.status === 'filled'

      return {
        success: true,
        orderId: result.id,
        filledPrice: isFilled && result.filled_avg_price ? parseFloat(result.filled_avg_price) : undefined,
        filledQty: isFilled && result.filled_qty ? parseFloat(result.filled_qty) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<OrderResult> {
    try {
      const patch: Record<string, unknown> = {}
      if (changes.qty != null) patch.qty = changes.qty
      if (changes.price != null) patch.limit_price = changes.price
      if (changes.stopPrice != null) patch.stop_price = changes.stopPrice
      if (changes.trailingAmount != null) patch.trail = changes.trailingAmount
      if (changes.trailingPercent != null) patch.trail = changes.trailingPercent
      if (changes.timeInForce) patch.time_in_force = changes.timeInForce

      const result = await this.client.replaceOrder(orderId, patch) as AlpacaOrderRaw
      const isFilled = result.status === 'filled'

      return {
        success: true,
        orderId: result.id,
        filledPrice: isFilled && result.filled_avg_price ? parseFloat(result.filled_avg_price) : undefined,
        filledQty: isFilled && result.filled_qty ? parseFloat(result.filled_qty) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.client.cancelOrder(orderId)
      return true
    } catch {
      return false
    }
  }

  async closePosition(contract: Contract, qty?: number): Promise<OrderResult> {
    const symbol = resolveSymbol(contract, this.provider)
    if (!symbol) {
      return { success: false, error: 'Cannot resolve contract to Alpaca symbol' }
    }

    // Partial close → reverse market order
    if (qty != null) {
      const positions = await this.getPositions()
      const pos = positions.find(p => p.contract.symbol === symbol)
      if (!pos) return { success: false, error: `No position for ${symbol}` }

      return this.placeOrder({
        contract,
        side: pos.side === 'long' ? 'sell' : 'buy',
        type: 'market',
        qty,
        timeInForce: 'day',
      })
    }

    // Full close → native Alpaca API
    try {
      const result = await this.client.closePosition(symbol) as AlpacaOrderRaw
      const isFilled = result.status === 'filled'
      return {
        success: true,
        orderId: result.id,
        filledPrice: isFilled && result.filled_avg_price ? parseFloat(result.filled_avg_price) : undefined,
        filledQty: isFilled && result.filled_qty ? parseFloat(result.filled_qty) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    const [account, positions, realizedPnL] = await Promise.all([
      this.client.getAccount() as Promise<AlpacaAccountRaw>,
      this.client.getPositions() as Promise<AlpacaPositionRaw[]>,
      this.getRealizedPnL(),
    ])

    // Alpaca account API doesn't provide unrealizedPnL — aggregate from positions
    const unrealizedPnL = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0)

    return {
      cash: parseFloat(account.cash),
      equity: parseFloat(account.equity),
      unrealizedPnL,
      realizedPnL,
      portfolioValue: parseFloat(account.portfolio_value),
      buyingPower: parseFloat(account.buying_power),
      dayTradeCount: account.daytrade_count,
      dayTradingBuyingPower: parseFloat(account.daytrading_buying_power),
    }
  }

  async getPositions(): Promise<Position[]> {
    const raw = await this.client.getPositions() as AlpacaPositionRaw[]

    return raw.map(p => ({
      contract: makeContract(p.symbol, this.provider),
      side: p.side === 'long' ? 'long' as const : 'short' as const,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: Math.abs(parseFloat(p.market_value)),
      unrealizedPnL: parseFloat(p.unrealized_pl),
      unrealizedPnLPercent: parseFloat(p.unrealized_plpc) * 100,
      costBasis: parseFloat(p.cost_basis),
      leverage: 1,
    }))
  }

  async getOrders(): Promise<Order[]> {
    const orders = await this.client.getOrders({
      status: 'all',
      limit: 100,
      until: undefined,
      after: undefined,
      direction: undefined,
      nested: undefined,
      symbols: undefined,
    }) as AlpacaOrderRaw[]

    return orders.map(o => this.mapOrder(o))
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const symbol = resolveSymbol(contract, this.provider)
    if (!symbol) throw new Error('Cannot resolve contract to Alpaca symbol')

    const snapshot = await this.client.getSnapshot(symbol) as AlpacaSnapshotRaw

    return {
      contract: makeContract(symbol, this.provider),
      last: snapshot.LatestTrade.Price,
      bid: snapshot.LatestQuote.BidPrice,
      ask: snapshot.LatestQuote.AskPrice,
      volume: snapshot.DailyBar.Volume,
      timestamp: new Date(snapshot.LatestTrade.Timestamp),
    }
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['STK'],
      supportedOrderTypes: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'],
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    const clock = await this.client.getClock() as AlpacaClockRaw
    return {
      isOpen: clock.is_open,
      nextOpen: new Date(clock.next_open),
      nextClose: new Date(clock.next_close),
      timestamp: new Date(clock.timestamp),
    }
  }

  // ---- Realized PnL ----

  /**
   * Get realized PnL from Alpaca FILL activities with TTL cache.
   * Fetches all historical fills, matches buys against sells per symbol using FIFO,
   * and sums the realized profit/loss.
   */
  private async getRealizedPnL(): Promise<number> {
    const now = Date.now()
    if (this.realizedPnLCache && (now - this.realizedPnLCache.updatedAt) < AlpacaAccount.REALIZED_PNL_TTL_MS) {
      return this.realizedPnLCache.value
    }

    try {
      const fills = await this.fetchAllFills()
      const value = computeRealizedPnL(fills)
      this.realizedPnLCache = { value, updatedAt: now }
      return value
    } catch (err) {
      // On error, return cached value if available, otherwise 0
      console.warn(`AlpacaAccount[${this.id}]: failed to fetch FILL activities:`, err)
      return this.realizedPnLCache?.value ?? 0
    }
  }

  /** Paginate through all FILL activities (newest first by default). */
  private async fetchAllFills(): Promise<AlpacaFillActivityRaw[]> {
    const all: AlpacaFillActivityRaw[] = []
    let pageToken: string | undefined

    for (;;) {
      const page = await this.client.getAccountActivities({
        activityTypes: 'FILL',
        pageSize: 100,
        pageToken,
        direction: 'asc', // oldest first → natural FIFO order
        until: undefined,
        after: undefined,
        date: undefined,
      }) as AlpacaFillActivityRaw[]

      if (!page || page.length === 0) break
      all.push(...page)

      // Alpaca pagination: last item's id is the next page_token
      if (page.length < 100) break
      pageToken = (page[page.length - 1] as unknown as { id: string }).id
    }

    return all
  }

  // ---- Internal ----

  private mapOrder(o: AlpacaOrderRaw): Order {
    return {
      id: o.id,
      contract: makeContract(o.symbol, this.provider),
      side: o.side as 'buy' | 'sell',
      type: o.type as Order['type'],
      qty: parseFloat(o.qty ?? o.notional ?? '0'),
      price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
      timeInForce: o.time_in_force as Order['timeInForce'],
      extendedHours: o.extended_hours,
      status: mapAlpacaOrderStatus(o.status),
      filledPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined,
      filledQty: o.filled_qty ? parseFloat(o.filled_qty) : undefined,
      filledAt: o.filled_at ? new Date(o.filled_at) : undefined,
      createdAt: new Date(o.created_at),
      rejectReason: o.reject_reason ?? undefined,
    }
  }
}
