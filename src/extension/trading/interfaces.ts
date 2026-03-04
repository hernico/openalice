/**
 * Unified Trading interfaces — IBKR-style Account model
 *
 * Merges the concepts from crypto-trading (ICryptoTradingEngine) and
 * securities-trading (ISecuritiesTradingEngine) into a single Account interface.
 * All providers (Alpaca, CCXT, IBKR, ...) implement ITradingAccount.
 */

import type { Contract, SecType } from './contract.js'

// ==================== Position ====================

/**
 * Unified position/holding.
 * Stocks are the special case: side='long', leverage=1, no margin/liquidation.
 */
export interface Position {
  contract: Contract
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  currentPrice: number
  marketValue: number
  unrealizedPnL: number
  unrealizedPnLPercent: number
  costBasis: number
  leverage: number
  margin?: number
  liquidationPrice?: number
}

// ==================== Orders ====================

export interface OrderRequest {
  contract: Contract
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop' | 'stop_limit'
  qty?: number
  notional?: number
  price?: number
  stopPrice?: number
  leverage?: number
  reduceOnly?: boolean
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok'
  extendedHours?: boolean
}

export interface OrderResult {
  success: boolean
  orderId?: string
  error?: string
  message?: string
  filledPrice?: number
  filledQty?: number
}

export interface Order {
  id: string
  contract: Contract
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop' | 'stop_limit'
  qty: number
  price?: number
  stopPrice?: number
  leverage?: number
  reduceOnly?: boolean
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok'
  extendedHours?: boolean
  status: 'pending' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled'
  filledPrice?: number
  filledQty?: number
  filledAt?: Date
  createdAt: Date
  rejectReason?: string
}

// ==================== Account info ====================

export interface AccountInfo {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  portfolioValue?: number
  buyingPower?: number
  totalMargin?: number
  dayTradeCount?: number
  dayTradingBuyingPower?: number
}

// ==================== Market data ====================

export interface Quote {
  contract: Contract
  last: number
  bid: number
  ask: number
  volume: number
  high?: number
  low?: number
  timestamp: Date
}

export interface FundingRate {
  contract: Contract
  fundingRate: number
  nextFundingTime?: Date
  previousFundingRate?: number
  timestamp: Date
}

/** [price, amount] */
export type OrderBookLevel = [price: number, amount: number]

export interface OrderBook {
  contract: Contract
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: Date
}

export interface MarketClock {
  isOpen: boolean
  nextOpen?: Date
  nextClose?: Date
  timestamp?: Date
}

// ==================== Account capabilities ====================

export interface AccountCapabilities {
  supportsLeverage: boolean
  supportsShort: boolean
  supportsNotional: boolean
  supportsFundingRate: boolean
  supportsOrderBook: boolean
  supportsMarketClock: boolean
  supportsExtendedHours: boolean
  supportedSecTypes: SecType[]
  supportedOrderTypes: OrderRequest['type'][]
}

// ==================== ITradingAccount ====================

export interface ITradingAccount {
  /** Unique account ID, e.g. "alpaca-paper", "bybit-main". */
  readonly id: string

  /** Provider name, e.g. "alpaca", "ccxt". */
  readonly provider: string

  /** User-facing display name. */
  readonly label: string

  // ---- Lifecycle ----

  init(): Promise<void>
  close(): Promise<void>

  // ---- Contract resolution (IBKR-style search) ----

  resolveContract(query: Partial<Contract>): Promise<Contract[]>

  // ---- Trading operations ----

  placeOrder(order: OrderRequest): Promise<OrderResult>
  cancelOrder(orderId: string): Promise<boolean>
  closePosition(contract: Contract, qty?: number): Promise<OrderResult>

  // ---- Queries ----

  getAccount(): Promise<AccountInfo>
  getPositions(): Promise<Position[]>
  getOrders(): Promise<Order[]>
  getQuote(contract: Contract): Promise<Quote>

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities

  // ---- Optional extensions ----

  getMarketClock?(): Promise<MarketClock>
  getFundingRate?(contract: Contract): Promise<FundingRate>
  getOrderBook?(contract: Contract, limit?: number): Promise<OrderBook>
  adjustLeverage?(contract: Contract, leverage: number): Promise<{ success: boolean; error?: string }>
}

// ==================== Wallet state ====================

export interface WalletState {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  positions: Position[]
  pendingOrders: Order[]
}
