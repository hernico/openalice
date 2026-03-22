/**
 * Broker Factory — creates broker instances from account config.
 *
 * Single function: AccountConfig → IBroker. No intermediate platform layer.
 */

import type { IBroker } from './types.js'
import { CcxtBroker } from './ccxt/CcxtBroker.js'
import { AlpacaBroker } from './alpaca/AlpacaBroker.js'
import { IbkrBroker } from './ibkr/IbkrBroker.js'
import type { AccountConfig } from '../../../core/config.js'

/** Create an IBroker from a merged account config. */
export function createBroker(config: AccountConfig): IBroker {
  switch (config.type) {
    case 'ccxt':
      return new CcxtBroker({
        id: config.id,
        label: config.label,
        exchange: config.exchange,
        sandbox: config.sandbox,
        demoTrading: config.demoTrading,
        options: config.options,
        apiKey: config.apiKey ?? '',
        apiSecret: config.apiSecret ?? '',
        password: config.password,
      })
    case 'alpaca':
      return new AlpacaBroker({
        id: config.id,
        label: config.label,
        apiKey: config.apiKey ?? '',
        secretKey: config.apiSecret ?? '',
        paper: config.paper,
      })
    case 'ibkr':
      return new IbkrBroker({
        id: config.id,
        label: config.label,
        host: config.host,
        port: config.port,
        clientId: config.clientId,
        accountId: config.accountId,
      })
  }
}
