/**
 * Trading-as-Git type definitions
 *
 * Unified git-like state management for tracking trading operation history.
 * Merges crypto-trading/wallet/types.ts and securities-trading/wallet/types.ts.
 */

import type { Position, Order } from '../interfaces.js'

// ==================== Commit Hash ====================

/** 8-character short SHA-256 hash. */
export type CommitHash = string

// ==================== Operation ====================

export type OperationAction =
  | 'placeOrder'
  | 'closePosition'
  | 'cancelOrder'
  | 'adjustLeverage'
  | 'syncOrders'

export interface Operation {
  action: OperationAction
  params: Record<string, unknown>
}

// ==================== Operation Result ====================

export type OperationStatus = 'filled' | 'pending' | 'rejected' | 'cancelled' | 'partially_filled'

export interface OperationResult {
  action: OperationAction
  success: boolean
  orderId?: string
  status: OperationStatus
  filledPrice?: number
  filledQty?: number
  error?: string
  raw?: unknown
}

// ==================== Wallet State ====================

/** State snapshot taken after each commit. Uses unified Position/Order types. */
export interface GitState {
  cash: number
  equity: number
  unrealizedPnL: number
  realizedPnL: number
  positions: Position[]
  pendingOrders: Order[]
}

// ==================== Commit ====================

export interface GitCommit {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  operations: Operation[]
  results: OperationResult[]
  stateAfter: GitState
  timestamp: string
  round?: number
}

// ==================== API Results ====================

export interface AddResult {
  staged: true
  index: number
  operation: Operation
}

export interface CommitPrepareResult {
  prepared: true
  hash: CommitHash
  message: string
  operationCount: number
}

export interface PushResult {
  hash: CommitHash
  message: string
  operationCount: number
  filled: OperationResult[]
  pending: OperationResult[]
  rejected: OperationResult[]
}

export interface GitStatus {
  staged: Operation[]
  pendingMessage: string | null
  head: CommitHash | null
  commitCount: number
}

export interface OperationSummary {
  symbol: string
  action: OperationAction
  change: string
  status: OperationStatus
}

export interface CommitLogEntry {
  hash: CommitHash
  parentHash: CommitHash | null
  message: string
  timestamp: string
  round?: number
  operations: OperationSummary[]
}

// ==================== Export State ====================

export interface GitExportState {
  commits: GitCommit[]
  head: CommitHash | null
}

// ==================== Sync ====================

export interface OrderStatusUpdate {
  orderId: string
  symbol: string
  previousStatus: OperationStatus
  currentStatus: OperationStatus
  filledPrice?: number
  filledQty?: number
}

export interface SyncResult {
  hash: CommitHash
  updatedCount: number
  updates: OrderStatusUpdate[]
}

// ==================== Simulate Price Change ====================

export interface PriceChangeInput {
  /** Contract aliceId or symbol, or "all". */
  symbol: string
  /** "@88000" (absolute) or "+10%" / "-5%" (relative). */
  change: string
}

export interface SimulationPositionCurrent {
  symbol: string
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  currentPrice: number
  unrealizedPnL: number
  marketValue: number
}

export interface SimulationPositionAfter {
  symbol: string
  side: 'long' | 'short'
  qty: number
  avgEntryPrice: number
  simulatedPrice: number
  unrealizedPnL: number
  marketValue: number
  pnlChange: number
  priceChangePercent: string
}

export interface SimulatePriceChangeResult {
  success: boolean
  error?: string
  currentState: {
    equity: number
    unrealizedPnL: number
    totalPnL: number
    positions: SimulationPositionCurrent[]
  }
  simulatedState: {
    equity: number
    unrealizedPnL: number
    totalPnL: number
    positions: SimulationPositionAfter[]
  }
  summary: {
    totalPnLChange: number
    equityChange: number
    equityChangePercent: string
    worstCase: string
  }
}
