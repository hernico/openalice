#!/usr/bin/env node

import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, "..")
const dataRoot = process.env.OPENALICE_DATA_DIR || path.join(appRoot, "data")
const configRoot = path.join(dataRoot, "config")
const seedRoot = process.env.OPENALICE_SEED_ROOT || "/opt/openalice/seed-data"
const defaultRoot = process.env.OPENALICE_DEFAULT_DATA_ROOT || "/opt/openalice/default-data"

function firstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && value !== "") {
      return value
    }
  }
  return undefined
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

function parseInteger(value, fallback) {
  if (value === undefined || value === "") {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseNumberList(value) {
  if (!value) {
    return []
  }
  return value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item))
}

function defaultModelForProvider(provider) {
  switch (provider) {
    case "openai":
      return "gpt-4.1-mini"
    case "google":
      return "gemini-2.5-pro"
    default:
      return "claude-sonnet-4-6"
  }
}

function inferProviderFromKeys() {
  if (firstEnv(["ANTHROPIC_API_KEY", "OPENALICE_ANTHROPIC_API_KEY"])) {
    return "anthropic"
  }
  if (firstEnv(["OPENAI_API_KEY", "OPENALICE_OPENAI_API_KEY"])) {
    return "openai"
  }
  if (firstEnv(["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "OPENALICE_GOOGLE_API_KEY"])) {
    return "google"
  }
  return undefined
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true })
}

async function copyTreeIfMissing(sourceRoot, targetRoot) {
  if (!existsSync(sourceRoot)) {
    return
  }
  await ensureDir(targetRoot)
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name)
    const targetPath = path.join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      await copyTreeIfMissing(sourcePath, targetPath)
      continue
    }
    if (!existsSync(targetPath)) {
      await ensureDir(path.dirname(targetPath))
      await fs.copyFile(sourcePath, targetPath)
    }
  }
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) {
    return structuredClone(fallback)
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function isAlpacaAccount(account, alpacaPlatformIds) {
  return alpacaPlatformIds.has(account.platformId) || account.id.startsWith("alpaca")
}

function ensureBrokerConfig(account) {
  if (!account.brokerConfig || typeof account.brokerConfig !== "object" || Array.isArray(account.brokerConfig)) {
    account.brokerConfig = {}
  }
  return account.brokerConfig
}

async function seedDataDirectories() {
  await copyTreeIfMissing(defaultRoot, path.join(dataRoot, "default"))
  await copyTreeIfMissing(seedRoot, dataRoot)
}

async function configureConnectors() {
  const filePath = path.join(configRoot, "connectors.json")
  const current = await readJson(filePath, {})
  const webPort = parseInteger(process.env.OPENALICE_WEB_PORT, current.web?.port ?? 3002)
  const mcpPort = parseInteger(process.env.OPENALICE_MCP_PORT, current.mcp?.port ?? 3001)
  const mcpAskEnabled = parseBoolean(
    process.env.OPENALICE_MCP_ASK_ENABLED,
    current.mcpAsk?.enabled ?? false,
  )
  const mcpAskPort = parseInteger(process.env.OPENALICE_MCP_ASK_PORT, current.mcpAsk?.port ?? 3003)
  const telegramEnabled = parseBoolean(
    process.env.OPENALICE_TELEGRAM_ENABLED,
    current.telegram?.enabled ?? false,
  )
  const telegramChatIds = process.env.OPENALICE_TELEGRAM_CHAT_IDS
    ? parseNumberList(process.env.OPENALICE_TELEGRAM_CHAT_IDS)
    : current.telegram?.chatIds ?? []

  const next = {
    web: { port: webPort },
    mcp: { port: mcpPort },
    mcpAsk: {
      enabled: mcpAskEnabled,
      ...(mcpAskEnabled || process.env.OPENALICE_MCP_ASK_PORT ? { port: mcpAskPort } : {}),
    },
    telegram: {
      enabled: telegramEnabled,
      ...(firstEnv(["OPENALICE_TELEGRAM_BOT_TOKEN"]) ? { botToken: process.env.OPENALICE_TELEGRAM_BOT_TOKEN } : current.telegram?.botToken ? { botToken: current.telegram.botToken } : {}),
      ...(firstEnv(["OPENALICE_TELEGRAM_BOT_USERNAME"]) ? { botUsername: process.env.OPENALICE_TELEGRAM_BOT_USERNAME } : current.telegram?.botUsername ? { botUsername: current.telegram.botUsername } : {}),
      chatIds: telegramChatIds,
    },
  }

  await writeJson(filePath, next)
  return next
}

async function configureAiProvider() {
  const filePath = path.join(configRoot, "ai-provider-manager.json")
  const current = await readJson(filePath, {})
  const inferredProvider = inferProviderFromKeys()
  const backend =
    firstEnv(["OPENALICE_AI_BACKEND"]) ||
    current.backend ||
    (inferredProvider ? "vercel-ai-sdk" : "claude-code")
  const provider =
    firstEnv(["OPENALICE_AI_PROVIDER"]) ||
    current.provider ||
    inferredProvider ||
    "anthropic"
  const next = {
    backend,
    provider,
    model: firstEnv(["OPENALICE_AI_MODEL"]) || current.model || defaultModelForProvider(provider),
    apiKeys: {
      ...(current.apiKeys || {}),
    },
  }

  const baseUrl = firstEnv(["OPENALICE_AI_BASE_URL"])
  if (baseUrl) {
    next.baseUrl = baseUrl
  } else if (current.baseUrl) {
    next.baseUrl = current.baseUrl
  }

  const anthropicKey = firstEnv(["ANTHROPIC_API_KEY", "OPENALICE_ANTHROPIC_API_KEY"])
  const openAiKey = firstEnv(["OPENAI_API_KEY", "OPENALICE_OPENAI_API_KEY"])
  const googleKey = firstEnv(["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "OPENALICE_GOOGLE_API_KEY"])

  if (anthropicKey) next.apiKeys.anthropic = anthropicKey
  if (openAiKey) next.apiKeys.openai = openAiKey
  if (googleKey) next.apiKeys.google = googleKey

  await writeJson(filePath, next)
  return next
}

async function configureTrading() {
  const platformsPath = path.join(configRoot, "platforms.json")
  const accountsPath = path.join(configRoot, "accounts.json")
  const securitiesPath = path.join(configRoot, "securities.json")

  const platforms = await readJson(platformsPath, [])
  const accounts = await readJson(accountsPath, [])
  const securities = await readJson(securitiesPath, {
    provider: { type: "alpaca", paper: true },
    guards: [],
  })

  const alpacaApiKey = firstEnv(["APCA_API_KEY_ID", "ALPACA_API_KEY_ID", "ALPACA_API_KEY"])
  const alpacaSecret = firstEnv(["APCA_API_SECRET_KEY", "ALPACA_SECRET_KEY", "ALPACA_API_SECRET"])
  const alpacaPaper = parseBoolean(
    process.env.OPENALICE_ALPACA_PAPER,
    securities.provider?.paper ?? true,
  )

  const alpacaPlatformIds = new Set()
  for (const platform of platforms) {
    if (platform.type === "alpaca") {
      platform.paper = alpacaPaper
      alpacaPlatformIds.add(platform.id)
    }
  }

  for (const account of accounts) {
    if (!isAlpacaAccount(account, alpacaPlatformIds)) {
      continue
    }
    account.type = account.type || "alpaca"
    account.enabled = account.enabled !== false
    const brokerConfig = ensureBrokerConfig(account)
    if (typeof account.apiKey === "string" && account.apiKey) {
      brokerConfig.apiKey = account.apiKey
      delete account.apiKey
    }
    if (typeof account.apiSecret === "string" && account.apiSecret) {
      brokerConfig.apiSecret = account.apiSecret
      delete account.apiSecret
    }
    brokerConfig.paper = alpacaPaper
    if (alpacaApiKey) {
      brokerConfig.apiKey = alpacaApiKey
    }
    if (alpacaSecret) {
      brokerConfig.apiSecret = alpacaSecret
    }
  }

  if (securities.provider?.type === "alpaca") {
    securities.provider.paper = alpacaPaper
    if (alpacaApiKey) securities.provider.apiKey = alpacaApiKey
    if (alpacaSecret) securities.provider.secretKey = alpacaSecret
  }

  await writeJson(platformsPath, platforms)
  await writeJson(accountsPath, accounts)
  await writeJson(securitiesPath, securities)
}

async function configureMarketData() {
  const filePath = path.join(configRoot, "market-data.json")
  const current = await readJson(filePath, {})
  const next = {
    enabled: parseBoolean(process.env.OPENALICE_MARKET_DATA_ENABLED, current.enabled ?? true),
    backend: firstEnv(["OPENALICE_MARKET_DATA_BACKEND"]) || current.backend || "typebb-sdk",
    apiUrl: firstEnv(["OPENALICE_MARKET_DATA_API_URL"]) || current.apiUrl || "http://localhost:6900",
    providers: {
      equity: firstEnv(["OPENALICE_MARKET_DATA_EQUITY_PROVIDER"]) || current.providers?.equity || "yfinance",
      crypto: firstEnv(["OPENALICE_MARKET_DATA_CRYPTO_PROVIDER"]) || current.providers?.crypto || "yfinance",
      currency: firstEnv(["OPENALICE_MARKET_DATA_CURRENCY_PROVIDER"]) || current.providers?.currency || "yfinance",
    },
    providerKeys: {
      ...(current.providerKeys || {}),
    },
    apiServer: {
      enabled: parseBoolean(
        process.env.OPENALICE_MARKET_DATA_API_ENABLED,
        current.apiServer?.enabled ?? true,
      ),
      port: parseInteger(
        process.env.OPENALICE_MARKET_DATA_API_PORT,
        current.apiServer?.port ?? 6901,
      ),
    },
  }

  const providerKeyMap = {
    fred: ["OPENALICE_FRED_API_KEY", "FRED_API_KEY"],
    fmp: ["OPENALICE_FMP_API_KEY", "FMP_API_KEY"],
    eia: ["OPENALICE_EIA_API_KEY", "EIA_API_KEY"],
    bls: ["OPENALICE_BLS_API_KEY", "BLS_API_KEY"],
    nasdaq: ["OPENALICE_NASDAQ_API_KEY", "NASDAQ_API_KEY"],
    tradingeconomics: ["OPENALICE_TRADINGECONOMICS_API_KEY", "TRADINGECONOMICS_API_KEY"],
    econdb: ["OPENALICE_ECONDB_API_KEY", "ECONDB_API_KEY"],
    intrinio: ["OPENALICE_INTRINIO_API_KEY", "INTRINIO_API_KEY"],
    benzinga: ["OPENALICE_BENZINGA_API_KEY", "BENZINGA_API_KEY"],
    tiingo: ["OPENALICE_TIINGO_API_KEY", "TIINGO_API_KEY"],
    biztoc: ["OPENALICE_BIZTOC_API_KEY", "BIZTOC_API_KEY"],
  }

  for (const [providerName, keys] of Object.entries(providerKeyMap)) {
    const value = firstEnv(keys)
    if (value) {
      next.providerKeys[providerName] = value
    }
  }

  await writeJson(filePath, next)
}

async function configureAlpacaEval() {
  const filePath = path.join(configRoot, "alpaca-eval.json")
  const current = await readJson(filePath, {})
  const next = {
    enabled: parseBoolean(
      process.env.OPENALICE_ALPACA_EVAL_ENABLED,
      current.enabled ?? false,
    ),
    accountId:
      firstEnv(["OPENALICE_ALPACA_EVAL_ACCOUNT_ID"]) ||
      current.accountId ||
      "alpaca-paper",
    symbols: process.env.OPENALICE_ALPACA_EVAL_SYMBOLS
      ? process.env.OPENALICE_ALPACA_EVAL_SYMBOLS
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : current.symbols || [],
    excludedSymbols: process.env.OPENALICE_ALPACA_EVAL_EXCLUDED_SYMBOLS
      ? process.env.OPENALICE_ALPACA_EVAL_EXCLUDED_SYMBOLS
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : current.excludedSymbols || [],
    marketDataFeed:
      firstEnv(["OPENALICE_ALPACA_EVAL_FEED"]) ||
      current.marketDataFeed ||
      "iex",
    sampleIntervalMs: parseInteger(
      process.env.OPENALICE_ALPACA_EVAL_SAMPLE_INTERVAL_MS,
      current.sampleIntervalMs ?? 1000,
    ),
    accountSnapshotIntervalMs: parseInteger(
      process.env.OPENALICE_ALPACA_EVAL_ACCOUNT_SNAPSHOT_INTERVAL_MS,
      current.accountSnapshotIntervalMs ?? 5000,
    ),
    marketClockIntervalMs: parseInteger(
      process.env.OPENALICE_ALPACA_EVAL_MARKET_CLOCK_INTERVAL_MS,
      current.marketClockIntervalMs ?? 60000,
    ),
    onlyWhenMarketOpen: parseBoolean(
      process.env.OPENALICE_ALPACA_EVAL_ONLY_MARKET_OPEN,
      current.onlyWhenMarketOpen ?? true,
    ),
    recordQuotes: parseBoolean(
      process.env.OPENALICE_ALPACA_EVAL_RECORD_QUOTES,
      current.recordQuotes ?? true,
    ),
    recordTrades: parseBoolean(
      process.env.OPENALICE_ALPACA_EVAL_RECORD_TRADES,
      current.recordTrades ?? true,
    ),
    recordTradeUpdates: parseBoolean(
      process.env.OPENALICE_ALPACA_EVAL_RECORD_TRADE_UPDATES,
      current.recordTradeUpdates ?? true,
    ),
    dataDir:
      firstEnv(["OPENALICE_ALPACA_EVAL_DATA_DIR"]) ||
      current.dataDir ||
      "data/alpaca-eval",
    timezone:
      firstEnv(["OPENALICE_ALPACA_EVAL_TIMEZONE", "TZ"]) ||
      current.timezone ||
      "America/New_York",
  }

  const marketDataStreamUrl = firstEnv(["OPENALICE_ALPACA_EVAL_MARKET_DATA_STREAM_URL"])
  if (marketDataStreamUrl) {
    next.marketDataStreamUrl = marketDataStreamUrl
  } else if (current.marketDataStreamUrl) {
    next.marketDataStreamUrl = current.marketDataStreamUrl
  }

  const tradingStreamUrl = firstEnv(["OPENALICE_ALPACA_EVAL_TRADING_STREAM_URL"])
  if (tradingStreamUrl) {
    next.tradingStreamUrl = tradingStreamUrl
  } else if (current.tradingStreamUrl) {
    next.tradingStreamUrl = current.tradingStreamUrl
  }

  await writeJson(filePath, next)
}

async function configureHeartbeat() {
  const filePath = path.join(configRoot, "heartbeat.json")
  const current = await readJson(filePath, {})
  const enabled = process.env.OPENALICE_HEARTBEAT_ENABLED
  if (enabled !== undefined && enabled !== "") {
    current.enabled = parseBoolean(enabled, current.enabled ?? true)
  }
  const every = firstEnv(["OPENALICE_HEARTBEAT_EVERY"])
  if (every) {
    current.every = every
  }
  if (!current.activeHours) {
    await writeJson(filePath, current)
    return
  }
  const timezone = firstEnv(["OPENALICE_HEARTBEAT_TIMEZONE", "TZ"])
  if (!timezone) {
    await writeJson(filePath, current)
    return
  }
  current.activeHours.timezone = timezone
  await writeJson(filePath, current)
}

async function main() {
  await seedDataDirectories()
  await ensureDir(configRoot)

  const connectors = await configureConnectors()
  const aiProvider = await configureAiProvider()
  await configureTrading()
  await configureMarketData()
  await configureAlpacaEval()
  await configureHeartbeat()

  console.log(
    `[bootstrap] OpenAlice ready on web:${connectors.web.port} mcp:${connectors.mcp.port} backend:${aiProvider.backend}`,
  )
}

await main()
