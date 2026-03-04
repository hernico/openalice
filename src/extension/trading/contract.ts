/**
 * Contract — IBKR-style instrument definition (1:1 replica)
 *
 * All fields are optional. A Contract serves both as a complete instrument
 * definition and as a search query (like IBKR's reqContractDetails).
 *
 * The only deviation from IBKR: `conId` is replaced by `aliceId` — a global
 * unique identifier with format "{provider}-{nativeId}".
 * Examples: "alpaca-AAPL", "binance-BTCUSDT", "ibkr-265598"
 */

// ==================== Security type ====================

export type SecType =
  | 'STK'     // Stock (or ETF)
  | 'OPT'     // Option
  | 'FUT'     // Future
  | 'FOP'     // Future Option
  | 'CASH'    // Forex pair
  | 'BOND'    // Bond
  | 'WAR'     // Warrant
  | 'CMDTY'   // Commodity
  | 'CRYPTO'  // Cryptocurrency
  | 'FUND'    // Mutual Fund
  | 'IND'     // Index
  | 'BAG'     // Combo (multi-leg)

// ==================== Option type ====================

export type OptionType = 'P' | 'PUT' | 'C' | 'CALL'

// ==================== Combo leg ====================

export interface ComboLeg {
  conId: number
  ratio: number
  action: 'BUY' | 'SELL'
  exchange: string
}

// ==================== Delta neutral ====================

export interface DeltaNeutralContract {
  conId: number
  delta: number
  price: number
}

// ==================== Contract ====================

export interface Contract {
  /** Global unique ID: "{provider}-{nativeId}". */
  aliceId?: string

  /** The underlying's asset symbol. */
  symbol?: string

  /** Security type. */
  secType?: SecType

  /**
   * Last trading day or contract month.
   * YYYYMM = contract month, YYYYMMDD = last trading day.
   * For Options and Futures only.
   */
  lastTradeDateOrContractMonth?: string

  /** Option strike price. */
  strike?: number

  /** Option right: Put or Call. */
  right?: OptionType

  /** Instrument multiplier (options, futures). */
  multiplier?: number

  /** Destination exchange. */
  exchange?: string

  /** Trading currency. */
  currency?: string

  /** Contract symbol within primary exchange (OCC symbol for US options). */
  localSymbol?: string

  /** Native exchange of the contract (for smart-routing disambiguation). */
  primaryExch?: string

  /** Trading class name (e.g. "FGBL" for Euro-Bund futures). */
  tradingClass?: string

  /** If true, include expired contracts in queries. */
  includeExpired?: boolean

  /** Security identifier type: "ISIN", "CUSIP", "SEDOL", "RIC". */
  secIdType?: string

  /** Security identifier value. */
  secId?: string

  /** Human-readable description. */
  description?: string

  /** Issuer ID. */
  issuerId?: string

  /** Textual description of combo legs. */
  comboLegsDescription?: string

  /** Legs of a combined contract definition. */
  comboLegs?: ComboLeg[]

  /** Delta-neutral combo order parameters. */
  deltaNeutralContract?: DeltaNeutralContract
}
