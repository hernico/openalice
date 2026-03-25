/**
 * Smoke test: generate Alpaca trade updates (order accepted + canceled)
 * without taking fill risk.
 *
 * Intended use:
 * - Run this on the same machine where OpenAlice is running with Alpaca Eval enabled,
 *   so the `alpaca-eval` trade update stream can capture the events to JSONL.
 *
 * Env vars required:
 * - APCA_API_KEY_ID
 * - APCA_API_SECRET_KEY
 * Optional:
 * - APCA_API_BASE_URL (default: https://paper-api.alpaca.markets)
 * - SMOKE_SYMBOL (default: SPY)
 * - SMOKE_QTY (default: 1)
 * - SMOKE_LIMIT_PCT (default: 0.98)
 */

import Alpaca from '@alpacahq/alpaca-trade-api'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env var: ${name}`)
  return value
}

function round2(value) {
  return Math.round(value * 100) / 100
}

async function main() {
  const keyId = requireEnv('APCA_API_KEY_ID')
  const secretKey = requireEnv('APCA_API_SECRET_KEY')
  const baseUrl = process.env.APCA_API_BASE_URL || 'https://paper-api.alpaca.markets'

  const symbol = (process.env.SMOKE_SYMBOL || 'SPY').toUpperCase()
  const qty = Number(process.env.SMOKE_QTY || '1')
  const limitPct = Number(process.env.SMOKE_LIMIT_PCT || '0.98')
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('SMOKE_QTY must be a positive number')
  if (!Number.isFinite(limitPct) || limitPct <= 0 || limitPct >= 1) throw new Error('SMOKE_LIMIT_PCT must be between 0 and 1')

  const alpaca = new Alpaca({
    keyId,
    secretKey,
    paper: true,
    baseUrl,
  })

  // Use the most recent trade price to anchor a "safe" limit order that should not fill immediately.
  // If this fails (data entitlement), fall back to a conservative hardcoded price and still exercise order updates.
  let lastPrice = null
  try {
    const trade = await alpaca.getLatestTrade(symbol)
    lastPrice = Number(trade?.Price ?? trade?.price ?? trade?.p)
  } catch {
    // ignore
  }

  const anchor = Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : 100
  const limitPrice = round2(anchor * limitPct)

  console.log(`[smoke] baseUrl=${baseUrl} symbol=${symbol} qty=${qty} limitPrice=${limitPrice}`)

  const order = await alpaca.createOrder({
    symbol,
    qty,
    side: 'buy',
    type: 'limit',
    time_in_force: 'day',
    limit_price: String(limitPrice),
  })

  console.log(`[smoke] created order id=${order?.id ?? '(unknown)'} status=${order?.status ?? '(unknown)'}`)

  // Small delay so the trade-updates stream has time to emit the "new" event before we cancel.
  await new Promise((r) => setTimeout(r, 4000))

  if (order?.id) {
    await alpaca.cancelOrder(order.id)
    console.log(`[smoke] canceled order id=${order.id}`)
  } else {
    console.log('[smoke] order id missing; skipping cancel')
  }

  console.log('[smoke] done. Next: confirm OpenAlice wrote trade-updates JSONL and the monthly archive picked it up.')
}

main().catch((err) => {
  console.error('[smoke] failed:', err?.message ?? String(err))
  process.exit(1)
})

