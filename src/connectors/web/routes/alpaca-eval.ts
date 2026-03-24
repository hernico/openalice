import { Hono } from 'hono'
import type { EngineContext } from '../../../core/types.js'

/** Alpaca evaluation routes: status + recent telemetry buffers. */
export function createAlpacaEvalRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/status', (c) => {
    if (!ctx.alpacaEval) {
      return c.json({
        enabled: false,
        running: false,
        reason: 'alpaca evaluation collector is not configured',
      })
    }
    return c.json(ctx.alpacaEval.getStatus())
  })

  app.get('/recent/:kind', (c) => {
    if (!ctx.alpacaEval) {
      return c.json({ error: 'alpaca evaluation collector is not configured' }, 404)
    }

    const kind = c.req.param('kind')
    const limit = Number(c.req.query('limit')) || 100

    switch (kind) {
      case 'market-seconds':
        return c.json({ entries: ctx.alpacaEval.recentMarketSeconds(limit) })
      case 'trade-updates':
        return c.json({ entries: ctx.alpacaEval.recentTradeUpdates(limit) })
      case 'account-snapshots':
        return c.json({ entries: ctx.alpacaEval.recentAccountSnapshots(limit) })
      default:
        return c.json({
          error: 'Invalid kind. Use market-seconds, trade-updates, or account-snapshots.',
        }, 400)
    }
  })

  return app
}
