/**
 * CcxtAccount — ITradingAccount adapter for CCXT exchanges
 *
 * Direct implementation against ccxt unified API. No SymbolMapper —
 * contract resolution searches exchange.markets on demand.
 * aliceId format: "{exchange}-{market.id}" (e.g. "bybit-BTCUSDT").
 */

import ccxt from 'ccxt'
import type { Exchange, Order as CcxtOrder } from 'ccxt'
import type { Contract, ContractDescription, ContractDetails, SecType } from '../../contract.js'
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
  FundingRate,
  OrderBook,
  OrderBookLevel,
} from '../../interfaces.js'
import type { CcxtAccountConfig, CcxtMarket } from './ccxt-types.js'
import { MAX_INIT_RETRIES, INIT_RETRY_BASE_MS } from './ccxt-types.js'
import {
  mapOrderStatus,
  marketToContract,
  contractToCcxt,
} from './ccxt-contracts.js'

export class CcxtAccount implements ITradingAccount {
  readonly id: string
  readonly provider: string  // "ccxt" or the specific exchange name
  readonly label: string

  private exchange: Exchange
  private exchangeName: string
  private defaultMarketType: 'spot' | 'swap'
  private initialized = false
  private readonly readOnly: boolean

  // orderId → ccxtSymbol cache (CCXT needs symbol to cancel)
  private orderSymbolCache = new Map<string, string>()

  constructor(config: CcxtAccountConfig) {
    this.exchangeName = config.exchange
    this.provider = config.exchange  // use exchange name as provider (e.g. "bybit", "binance")
    this.id = config.id ?? `${config.exchange}-main`
    this.label = config.label ?? `${config.exchange.charAt(0).toUpperCase() + config.exchange.slice(1)} ${config.sandbox ? 'Testnet' : 'Live'}`
    this.defaultMarketType = config.defaultMarketType
    this.readOnly = !config.apiKey || !config.apiSecret

    const exchanges = ccxt as unknown as Record<string, new (opts: Record<string, unknown>) => Exchange>
    const ExchangeClass = exchanges[config.exchange]
    if (!ExchangeClass) {
      throw new Error(`Unknown CCXT exchange: ${config.exchange}`)
    }

    // Default: skip option markets to reduce concurrent requests during loadMarkets
    // (bybit fires 6 parallel requests by default, which is unreliable through proxies)
    const defaultOptions: Record<string, unknown> = {
      fetchMarkets: { types: ['spot', 'linear', 'inverse'] },
    }
    const mergedOptions = { ...defaultOptions, ...config.options }

    this.exchange = new ExchangeClass({
      apiKey: config.apiKey,
      secret: config.apiSecret,
      password: config.password,
      options: mergedOptions,
    })

    if (config.sandbox) {
      this.exchange.setSandboxMode(true)
    }

    if (config.demoTrading) {
      (this.exchange as unknown as { enableDemoTrading: (enable: boolean) => void }).enableDemoTrading(true)
    }
  }

  // ---- Helpers ----

  private get markets() {
    return this.exchange.markets as unknown as Record<string, CcxtMarket>
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error(`CcxtAccount[${this.id}] not initialized. Call init() first.`)
    }
  }

  private ensureWritable(): void {
    if (this.readOnly) {
      throw new Error(
        `CcxtAccount[${this.id}] is in read-only mode (no API keys). This operation requires authentication.`,
      )
    }
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    if (this.readOnly) {
      console.log(
        `CcxtAccount[${this.id}]: no API credentials — running in market-data-only mode. ` +
        `Set apiKey and apiSecret in accounts.json for trading.`,
      )
    }

    // CCXT's fetchMarkets fires all market-type requests via Promise.all —
    // a single failure kills the entire batch. Monkey-patch fetchMarkets to
    // run each type sequentially with per-type retries.
    const origFetchMarkets = this.exchange.fetchMarkets.bind(this.exchange)
    const accountId = this.id

    this.exchange.fetchMarkets = async (params?: Record<string, unknown>) => {
      const ex = this.exchange as unknown as Record<string, unknown>
      const opts = (ex['options'] ?? {}) as Record<string, unknown>
      const fmOpts = (opts['fetchMarkets'] ?? {}) as Record<string, unknown>
      const types = (fmOpts['types'] ?? ['spot', 'linear', 'inverse']) as string[]

      const allMarkets: unknown[] = []
      for (const type of types) {
        for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
          try {
            // Temporarily override types to load a single type
            const prevTypes = fmOpts['types']
            fmOpts['types'] = [type]
            const markets = await origFetchMarkets(params)
            fmOpts['types'] = prevTypes
            allMarkets.push(...markets)
            break
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (attempt < MAX_INIT_RETRIES) {
              const delay = INIT_RETRY_BASE_MS * Math.pow(2, attempt - 1)
              console.warn(`CcxtAccount[${accountId}]: fetchMarkets(${type}) attempt ${attempt}/${MAX_INIT_RETRIES} failed, retrying in ${delay}ms...`)
              await new Promise(r => setTimeout(r, delay))
            } else {
              console.warn(`CcxtAccount[${accountId}]: fetchMarkets(${type}) failed after ${MAX_INIT_RETRIES} attempts: ${msg} — skipping`)
            }
          }
        }
      }
      return allMarkets as Awaited<ReturnType<Exchange['fetchMarkets']>>
    }

    // Now loadMarkets will use our sequential fetchMarkets
    try {
      await this.exchange.loadMarkets()
    } catch (err) {
      throw new Error(
        `Failed to connect to ${this.exchangeName} — check network connectivity. ` +
        `${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const marketCount = Object.keys(this.exchange.markets).length
    if (marketCount === 0) {
      throw new Error(`CcxtAccount[${this.id}]: failed to load any markets`)
    }
    this.initialized = true
    const mode = this.readOnly ? ', read-only (no API keys)' : ''
    console.log(`CcxtAccount[${this.id}]: connected (${this.exchangeName}, ${marketCount} markets loaded${mode})`)
  }

  async close(): Promise<void> {
    // CCXT exchanges typically don't need explicit closing
  }

  // ---- Contract search ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    this.ensureInit()
    if (!pattern) return []

    const searchBase = pattern.toUpperCase()
    const matchedMarkets: CcxtMarket[] = []

    for (const market of Object.values(this.markets)) {
      if (market.active === false) continue
      if (market.base.toUpperCase() !== searchBase) continue

      // Default filter: only USDT/USD/USDC quoted markets (skip exotic pairs)
      const quote = market.quote.toUpperCase()
      if (quote !== 'USDT' && quote !== 'USD' && quote !== 'USDC') continue

      matchedMarkets.push(market)
    }

    // Sort: preferred market type first, then USDT > USD > USDC
    const typeOrder = this.defaultMarketType === 'swap'
      ? { swap: 0, future: 1, spot: 2, option: 3 }
      : { spot: 0, swap: 1, future: 2, option: 3 }
    const quoteOrder: Record<string, number> = { USDT: 0, USD: 1, USDC: 2 }

    matchedMarkets.sort((a, b) => {
      const aType = typeOrder[a.type as keyof typeof typeOrder] ?? 99
      const bType = typeOrder[b.type as keyof typeof typeOrder] ?? 99
      if (aType !== bType) return aType - bType
      const aQuote = quoteOrder[a.quote.toUpperCase()] ?? 99
      const bQuote = quoteOrder[b.quote.toUpperCase()] ?? 99
      return aQuote - bQuote
    })

    // Collect derivative types available for this base asset
    const derivativeTypes = new Set<SecType>()
    for (const m of matchedMarkets) {
      if (m.type === 'future') derivativeTypes.add('FUT')
      if (m.type === 'option') derivativeTypes.add('OPT')
    }
    const derivativeSecTypes: SecType[] | undefined = derivativeTypes.size > 0
      ? Array.from(derivativeTypes)
      : undefined

    return matchedMarkets.map(market => ({
      contract: marketToContract(market, this.exchangeName),
      derivativeSecTypes,
    }))
  }

  async getContractDetails(query: Partial<Contract>): Promise<ContractDetails | null> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(query as Contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) return null

    const market = this.markets[ccxtSymbol]
    if (!market) return null

    return {
      contract: marketToContract(market, this.exchangeName),
      longName: `${market.base}/${market.quote} ${market.type}${market.settle ? ` (${market.settle} settled)` : ''}`,
      minTick: market.precision?.price,
    }
  }

  // ---- Trading operations ----

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.ensureInit()
    this.ensureWritable()

    const ccxtSymbol = contractToCcxt(order.contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) {
      return { success: false, error: 'Cannot resolve contract to CCXT symbol' }
    }

    let size = order.qty

    // Notional → size conversion
    if (!size && order.notional) {
      const ticker = await this.exchange.fetchTicker(ccxtSymbol)
      const price = order.price ?? ticker.last
      if (!price) {
        return { success: false, error: 'Cannot determine price for notional conversion' }
      }
      size = order.notional / price
    }

    if (!size) {
      return { success: false, error: 'Either qty or notional must be provided' }
    }

    try {
      const params: Record<string, unknown> = {}
      if (order.reduceOnly) params.reduceOnly = true

      const ccxtOrder = await this.exchange.createOrder(
        ccxtSymbol,
        order.type,
        order.side,
        size,
        order.type === 'limit' ? order.price : undefined,
        params,
      )

      // Cache orderId → symbol
      if (ccxtOrder.id) {
        this.orderSymbolCache.set(ccxtOrder.id, ccxtSymbol)
      }

      const status = mapOrderStatus(ccxtOrder.status)

      return {
        success: true,
        orderId: ccxtOrder.id,
        message: `Order ${ccxtOrder.id} ${status}`,
        filledPrice: status === 'filled' ? (ccxtOrder.average ?? ccxtOrder.price ?? undefined) : undefined,
        filledQty: status === 'filled' ? (ccxtOrder.filled ?? undefined) : undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.ensureInit()
    this.ensureWritable()

    try {
      const ccxtSymbol = this.orderSymbolCache.get(orderId)
      await this.exchange.cancelOrder(orderId, ccxtSymbol)
      return true
    } catch {
      return false
    }
  }

  async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<OrderResult> {
    this.ensureInit()
    this.ensureWritable()

    try {
      const ccxtSymbol = this.orderSymbolCache.get(orderId)
      if (!ccxtSymbol) {
        return { success: false, error: `Unknown order ${orderId} — cannot resolve symbol for edit` }
      }

      // editOrder requires type and side — fetch the original order to fill in defaults
      const original = await this.exchange.fetchOrder(orderId, ccxtSymbol)
      const result = await this.exchange.editOrder(
        orderId,
        ccxtSymbol,
        (changes.type as string) ?? original.type,
        original.side,
        changes.qty ?? original.amount,
        changes.price ?? original.price,
      )

      return {
        success: true,
        orderId: result.id,
        filledPrice: result.average ?? undefined,
        filledQty: result.filled ?? undefined,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async closePosition(contract: Contract, qty?: number): Promise<OrderResult> {
    this.ensureInit()
    this.ensureWritable()

    const positions = await this.getPositions()
    const symbol = contract.symbol?.toUpperCase()
    const aliceId = contract.aliceId

    const pos = positions.find(p =>
      (aliceId && p.contract.aliceId === aliceId) ||
      (symbol && p.contract.symbol === symbol),
    )

    if (!pos) {
      return { success: false, error: `No open position for ${aliceId ?? symbol ?? 'unknown'}` }
    }

    return this.placeOrder({
      contract: pos.contract,
      side: pos.side === 'long' ? 'sell' : 'buy',
      type: 'market',
      qty: qty ?? pos.qty,
      reduceOnly: true,
    })
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    this.ensureInit()
    this.ensureWritable()

    const [balance, rawPositions] = await Promise.all([
      this.exchange.fetchBalance(),
      this.exchange.fetchPositions(),
    ])

    const bal = balance as unknown as Record<string, Record<string, unknown>>
    const total = parseFloat(String(bal['total']?.['USDT'] ?? bal['total']?.['USD'] ?? 0))
    const free = parseFloat(String(bal['free']?.['USDT'] ?? bal['free']?.['USD'] ?? 0))
    const used = parseFloat(String(bal['used']?.['USDT'] ?? bal['used']?.['USD'] ?? 0))

    let unrealizedPnL = 0
    let realizedPnL = 0
    for (const p of rawPositions) {
      unrealizedPnL += parseFloat(String(p.unrealizedPnl ?? 0))
      realizedPnL += parseFloat(String((p as unknown as Record<string, unknown>).realizedPnl ?? 0))
    }

    return {
      cash: free,
      equity: total,
      unrealizedPnL,
      realizedPnL,
      totalMargin: used,
    }
  }

  async getPositions(): Promise<Position[]> {
    this.ensureInit()
    this.ensureWritable()

    const raw = await this.exchange.fetchPositions()
    const result: Position[] = []

    for (const p of raw) {
      const market = this.markets[p.symbol]
      if (!market) continue

      const size = Math.abs(parseFloat(String(p.contracts ?? 0)) * parseFloat(String(p.contractSize ?? 1)))
      if (size === 0) continue

      const markPrice = parseFloat(String(p.markPrice ?? 0))
      const entryPrice = parseFloat(String(p.entryPrice ?? 0))
      const marketValue = size * markPrice
      const costBasis = size * entryPrice
      const unrealizedPnL = parseFloat(String(p.unrealizedPnl ?? 0))

      result.push({
        contract: marketToContract(market, this.exchangeName),
        side: p.side === 'long' ? 'long' : 'short',
        qty: size,
        avgEntryPrice: entryPrice,
        currentPrice: markPrice,
        marketValue,
        unrealizedPnL,
        unrealizedPnLPercent: costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0,
        costBasis,
        leverage: parseFloat(String(p.leverage ?? 1)),
        margin: parseFloat(String(p.initialMargin ?? p.collateral ?? 0)),
        liquidationPrice: parseFloat(String(p.liquidationPrice ?? 0)) || undefined,
      })
    }

    return result
  }

  async getOrders(): Promise<Order[]> {
    this.ensureInit()
    this.ensureWritable()

    const allOrders: CcxtOrder[] = []

    try {
      const open = await this.exchange.fetchOpenOrders()
      allOrders.push(...open)
    } catch {
      // Some exchanges don't support fetchOpenOrders
    }

    try {
      const closed = await this.exchange.fetchClosedOrders(undefined, undefined, 50)
      allOrders.push(...closed)
    } catch {
      // Some exchanges don't support fetchClosedOrders
    }

    const result: Order[] = []

    for (const o of allOrders) {
      const market = this.markets[o.symbol]
      if (!market) continue

      if (o.id) {
        this.orderSymbolCache.set(o.id, o.symbol)
      }

      result.push({
        id: o.id,
        contract: marketToContract(market, this.exchangeName),
        side: o.side as 'buy' | 'sell',
        type: (o.type ?? 'market') as Order['type'],
        qty: o.amount ?? 0,
        price: o.price ?? undefined,
        reduceOnly: o.reduceOnly ?? false,
        status: mapOrderStatus(o.status),
        filledPrice: o.average ?? undefined,
        filledQty: o.filled ?? undefined,
        filledAt: o.lastTradeTimestamp ? new Date(o.lastTradeTimestamp) : undefined,
        createdAt: new Date(o.timestamp ?? Date.now()),
      })
    }

    return result
  }

  async getQuote(contract: Contract): Promise<Quote> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) throw new Error('Cannot resolve contract to CCXT symbol')

    const ticker = await this.exchange.fetchTicker(ccxtSymbol)
    const market = this.markets[ccxtSymbol]

    return {
      contract: market
        ? marketToContract(market, this.exchangeName)
        : contract,
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      volume: ticker.baseVolume ?? 0,
      high: ticker.high ?? undefined,
      low: ticker.low ?? undefined,
      timestamp: new Date(ticker.timestamp ?? Date.now()),
    }
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['CRYPTO'],
      supportedOrderTypes: ['market', 'limit'],
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    return {
      isOpen: true,
      timestamp: new Date(),
    }
  }

  // ---- Provider-specific methods ----

  async getFundingRate(contract: Contract): Promise<FundingRate> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) throw new Error('Cannot resolve contract to CCXT symbol')

    const funding = await this.exchange.fetchFundingRate(ccxtSymbol)
    const market = this.markets[ccxtSymbol]

    return {
      contract: market
        ? marketToContract(market, this.exchangeName)
        : contract,
      fundingRate: funding.fundingRate ?? 0,
      nextFundingTime: funding.fundingDatetime ? new Date(funding.fundingDatetime) : undefined,
      previousFundingRate: funding.previousFundingRate ?? undefined,
      timestamp: new Date(funding.timestamp ?? Date.now()),
    }
  }

  async getOrderBook(contract: Contract, limit?: number): Promise<OrderBook> {
    this.ensureInit()

    const ccxtSymbol = contractToCcxt(contract, this.markets, this.exchangeName)
    if (!ccxtSymbol) throw new Error('Cannot resolve contract to CCXT symbol')

    const book = await this.exchange.fetchOrderBook(ccxtSymbol, limit)
    const market = this.markets[ccxtSymbol]

    return {
      contract: market
        ? marketToContract(market, this.exchangeName)
        : contract,
      bids: book.bids.map(([p, a]) => [p ?? 0, a ?? 0] as OrderBookLevel),
      asks: book.asks.map(([p, a]) => [p ?? 0, a ?? 0] as OrderBookLevel),
      timestamp: new Date(book.timestamp ?? Date.now()),
    }
  }
}
