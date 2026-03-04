import type { OperationGuard, GuardContext } from './types.js'

const DEFAULT_MAX_PERCENT = 25

export class MaxPositionSizeGuard implements OperationGuard {
  readonly name = 'max-position-size'
  private maxPercent: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const { positions, account, operation } = ctx
    const symbol = operation.params.symbol as string

    const existing = positions.find(p => p.contract.symbol === symbol)
    const currentValue = existing?.marketValue ?? 0

    // Estimate added value — handle both crypto (usd_size/size) and securities (notional/qty) params
    const dollarAmount = (operation.params.notional ?? operation.params.usd_size) as number | undefined
    const quantity = (operation.params.qty ?? operation.params.size) as number | undefined

    let addedValue = 0
    if (dollarAmount) {
      addedValue = dollarAmount
    } else if (quantity && existing) {
      addedValue = quantity * existing.currentPrice
    }
    // If we can't estimate (new symbol + qty-based without existing position), allow — broker will validate

    if (addedValue === 0) return null

    const projectedValue = currentValue + addedValue
    const percent = account.equity > 0 ? (projectedValue / account.equity) * 100 : 0

    if (percent > this.maxPercent) {
      return `Position for ${symbol} would be ${percent.toFixed(1)}% of equity (limit: ${this.maxPercent}%)`
    }

    return null
  }
}
