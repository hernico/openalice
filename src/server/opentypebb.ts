/**
 * Embedded OpenBB API Server
 *
 * Starts an OpenBB-compatible HTTP server using opentypebb in-process.
 * Exposes the same REST endpoints as the Python OpenBB sidecar, allowing
 * external tools to connect to Alice's built-in data engine.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { createExecutor, loadAllRouters } from '@traderalice/opentypebb'

export function startEmbeddedOpenBBServer(port: number): void {
  const executor = createExecutor()

  const app = new Hono()
  app.use(cors())
  app.get('/api/v1/health', (c) => c.json({ status: 'ok' }))

  const rootRouter = loadAllRouters()
  rootRouter.mountToHono(app, executor)

  serve({ fetch: app.fetch, port })
  console.log(`[openbb] Embedded API server listening on http://localhost:${port}`)
}
