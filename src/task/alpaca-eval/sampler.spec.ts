import { describe, expect, it } from 'vitest'
import {
  buildEvaluationView,
  buildMarketDataStreamUrl,
  buildTradingStreamUrl,
  buildMarketSecondRecord,
  normalizeWsPayload,
} from './sampler.js'

describe('alpaca eval sampler helpers', () => {
  it('normalizes websocket payload arrays from buffers', () => {
    const raw = Buffer.from(JSON.stringify([{ T: 'q', S: 'AAPL', bp: 100.1 }]), 'utf8')
    expect(normalizeWsPayload(raw)).toEqual([{ T: 'q', S: 'AAPL', bp: 100.1 }])
  })

  it('builds default websocket endpoints', () => {
    expect(buildMarketDataStreamUrl('iex')).toBe('wss://stream.data.alpaca.markets/v2/iex')
    expect(buildMarketDataStreamUrl('sip')).toBe('wss://stream.data.alpaca.markets/v2/sip')
    expect(buildTradingStreamUrl()).toBe('wss://paper-api.alpaca.markets/stream')
  })

  it('prefers explicit websocket endpoint overrides', () => {
    expect(buildMarketDataStreamUrl('iex', 'wss://example.test/market')).toBe('wss://example.test/market')
    expect(buildTradingStreamUrl('wss://example.test/trading')).toBe('wss://example.test/trading')
  })

  it('builds one second record across all configured symbols', () => {
    const symbolStates = new Map([
      ['AAPL', {
        quote: {
          bid: 199.95,
          ask: 200.05,
          bidSize: 2,
          askSize: 3,
          bidExchange: 'V',
          askExchange: 'V',
          timestamp: '2026-03-18T13:30:01.100Z',
        },
        trade: {
          price: 200,
          size: 100,
          exchange: 'V',
          conditions: ['@'],
          tape: 'C',
          timestamp: '2026-03-18T13:30:01.050Z',
        },
      }],
    ])

    const record = buildMarketSecondRecord({
      accountId: 'alpaca-paper',
      feed: 'iex',
      sampleTs: '2026-03-18T13:30:01.000Z',
      symbols: ['AAPL', 'MSFT'],
      marketClock: {
        isOpen: true,
        nextOpen: '2026-03-19T13:30:00.000Z',
        nextClose: '2026-03-18T20:00:00.000Z',
        timestamp: '2026-03-18T13:30:01.000Z',
      },
      symbolStates,
    })

    expect(record.symbols.AAPL).toMatchObject({
      bid: 199.95,
      ask: 200.05,
      last: 200,
      lastSize: 100,
    })
    expect(record.symbols.AAPL.spread).toBeCloseTo(0.1, 10)
    expect(record.symbols.MSFT).toMatchObject({
      bid: null,
      ask: null,
      last: null,
    })
  })

  it('builds evaluation account view excluding configured symbols', () => {
    const evaluation = buildEvaluationView({
      account: {
        netLiquidation: 100_284.04,
        totalCashValue: 90_792.04,
        unrealizedPnL: 646,
        realizedPnL: 0,
        buyingPower: 389_964.16,
      },
      positions: [
        {
          symbol: 'ASTS',
          side: 'long',
          quantity: '100',
          avgCost: 88.46,
          marketPrice: 94.92,
          marketValue: 9_492,
          unrealizedPnL: 646,
          realizedPnL: 0,
          leverage: 1,
        },
        {
          symbol: 'AAPL',
          side: 'long',
          quantity: '10',
          avgCost: 200,
          marketPrice: 202,
          marketValue: 2_020,
          unrealizedPnL: 20,
          realizedPnL: 0,
          leverage: 1,
        },
      ],
      openOrders: [
        {
          symbol: 'ASTS',
          side: 'BUY',
          quantity: '10',
          orderType: 'LMT',
          timeInForce: 'DAY',
          limitPrice: 95,
          stopPrice: null,
          status: 'Submitted',
          warningText: null,
        },
      ],
      excludedSymbols: ['asts'],
    })

    expect(evaluation.excludedSymbols).toEqual(['ASTS'])
    expect(evaluation.excludedPositionCount).toBe(1)
    expect(evaluation.excludedOrderCount).toBe(1)
    expect(evaluation.excludedMarketValue).toBe(9_492)
    expect(evaluation.excludedUnrealizedPnL).toBe(646)
    expect(evaluation.account.netLiquidation).toBe(90_792.04)
    expect(evaluation.account.unrealizedPnL).toBe(0)
    expect(evaluation.positions.map((position) => position.symbol)).toEqual(['AAPL'])
    expect(evaluation.openOrders).toEqual([])
  })
})
