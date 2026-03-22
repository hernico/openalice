/**
 * UTA — Bybit demo lifecycle e2e.
 *
 * Full Trading-as-Git flow: stage → commit → push → sync → verify
 * against Bybit demo trading (crypto perps, 24/7).
 *
 * Run: pnpm test:e2e
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getTestAccounts, filterByProvider } from './setup.js'
import { UnifiedTradingAccount } from '../../UnifiedTradingAccount.js'
import type { IBroker } from '../../brokers/types.js'
import '../../contract-ext.js'

describe('UTA — Bybit lifecycle (ETH perp)', () => {
  let broker: IBroker | null = null
  let ethAliceId: string = ''

  beforeAll(async () => {
    const all = await getTestAccounts()
    const bybit = filterByProvider(all, 'ccxt').find(a => a.id.includes('bybit'))
    if (!bybit) {
      console.log('e2e: No Bybit demo account, skipping')
      return
    }
    broker = bybit.broker

    const results = await broker.searchContracts('ETH')
    const perp = results.find(r => r.contract.localSymbol?.includes('USDT:USDT'))
    if (!perp) {
      console.log('e2e: No ETH/USDT perp found, skipping')
      broker = null
      return
    }
    const nativeKey = perp.contract.localSymbol!
    ethAliceId = `${bybit.id}|${nativeKey}`
    console.log(`UTA Bybit: ETH perp aliceId=${ethAliceId}`)
  }, 60_000)

  beforeEach(({ skip }) => { if (!broker) skip('no Bybit demo account') })

  it('buy → sync → verify → close → sync → verify', async () => {
    const uta = new UnifiedTradingAccount(broker!)

    // Record initial state
    const initialPositions = await broker!.getPositions()
    const initialEthQty = initialPositions.find(p => p.contract.localSymbol?.includes('USDT:USDT'))?.quantity.toNumber() ?? 0
    console.log(`  initial ETH qty=${initialEthQty}`)

    // === Stage + Commit + Push: buy 0.01 ETH ===
    const addResult = uta.stagePlaceOrder({
      aliceId: ethAliceId,
      side: 'buy',
      type: 'market',
      qty: 0.01,
    })
    expect(addResult.staged).toBe(true)
    console.log(`  staged: ok`)

    const commitResult = uta.commit('e2e: buy 0.01 ETH')
    expect(commitResult.prepared).toBe(true)
    console.log(`  committed: hash=${commitResult.hash}`)

    const pushResult = await uta.push()
    console.log(`  pushed: submitted=${pushResult.submitted.length}, rejected=${pushResult.rejected.length}, status=${pushResult.submitted[0]?.status}`)
    expect(pushResult.submitted).toHaveLength(1)
    expect(pushResult.rejected).toHaveLength(0)

    const buyOrderId = pushResult.submitted[0].orderId
    console.log(`  orderId: ${buyOrderId}`)
    expect(buyOrderId).toBeDefined()

    // === Sync: may or may not have updates depending on whether fill was synchronous ===
    if (pushResult.submitted[0].status === 'submitted') {
      const sync1 = await uta.sync({ delayMs: 3000 })
      console.log(`  sync1: updatedCount=${sync1.updatedCount}`)
      expect(sync1.updatedCount).toBe(1)
      expect(sync1.updates[0].currentStatus).toBe('filled')
    } else {
      console.log(`  sync1: skipped (already ${pushResult.submitted[0].status} at push time)`)
    }

    // === Verify: position exists ===
    const state1 = await uta.getState()
    const ethPos = state1.positions.find(p => p.contract.aliceId === ethAliceId)
    console.log(`  state: ETH qty=${ethPos?.quantity}, pending=${state1.pendingOrders.length}`)
    expect(ethPos).toBeDefined()
    expect(state1.pendingOrders).toHaveLength(0)

    // === Stage + Commit + Push: close 0.01 ETH ===
    uta.stageClosePosition({ aliceId: ethAliceId, qty: 0.01 })
    uta.commit('e2e: close 0.01 ETH')
    const closePush = await uta.push()
    console.log(`  close pushed: submitted=${closePush.submitted.length}, status=${closePush.submitted[0]?.status}`)
    expect(closePush.submitted).toHaveLength(1)

    // === Sync: same — depends on fill timing ===
    if (closePush.submitted[0].status === 'submitted') {
      const sync2 = await uta.sync({ delayMs: 3000 })
      console.log(`  sync2: updatedCount=${sync2.updatedCount}`)
      expect(sync2.updatedCount).toBe(1)
      expect(sync2.updates[0].currentStatus).toBe('filled')
    } else {
      console.log(`  sync2: skipped (already ${closePush.submitted[0].status} at push time)`)
    }

    // === Verify: net change should be ~0 ===
    const finalPositions = await broker!.getPositions()
    const finalEthQty = finalPositions.find(p => p.contract.localSymbol?.includes('USDT:USDT'))?.quantity.toNumber() ?? 0
    console.log(`  final ETH qty=${finalEthQty} (initial was ${initialEthQty})`)
    expect(Math.abs(finalEthQty - initialEthQty)).toBeLessThan(0.02)

    // === Log: 2 commits ===
    const history = uta.log()
    console.log(`  log: ${history.length} commits — [${history.map(h => h.message).join(', ')}]`)
    expect(history.length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
