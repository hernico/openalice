// Contract
export type {
  Contract,
  SecType,
  OptionType,
  ComboLeg,
  DeltaNeutralContract,
} from './contract.js'

// Interfaces
export type {
  Position,
  OrderRequest,
  OrderResult,
  Order,
  AccountInfo,
  Quote,
  FundingRate,
  OrderBookLevel,
  OrderBook,
  MarketClock,
  AccountCapabilities,
  ITradingAccount,
  WalletState,
} from './interfaces.js'

// AccountManager
export { AccountManager } from './account-manager.js'
export type {
  AccountEntry,
  AccountSummary,
  AggregatedEquity,
  ContractSearchResult,
} from './account-manager.js'

// Trading-as-Git
export { TradingGit } from './git/index.js'
export type {
  ITradingGit,
  TradingGitConfig,
  CommitHash,
  Operation,
  OperationAction,
  OperationResult,
  OperationStatus,
  AddResult,
  CommitPrepareResult,
  PushResult,
  GitStatus,
  GitCommit,
  GitState,
  CommitLogEntry,
  GitExportState,
  OperationSummary,
  OrderStatusUpdate,
  SyncResult,
  PriceChangeInput,
  SimulatePriceChangeResult,
} from './git/index.js'

// Guards
export {
  createGuardPipeline,
  registerGuard,
  resolveGuards,
  MaxPositionSizeGuard,
  MaxLeverageGuard,
  CooldownGuard,
  SymbolWhitelistGuard,
} from './guards/index.js'
export type {
  GuardContext,
  OperationGuard,
  GuardRegistryEntry,
} from './guards/index.js'
