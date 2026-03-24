# Deploy En VPS

Esta variante de OpenAlice queda preparada para una VPS Linux usando Docker Compose y persistiendo todo `data/` en disco.

## 1. Preparar entorno

```bash
cd /ruta/a/openalice-paper-eval
cp .env.example .env
mkdir -p data
```

Edita `.env` y define como minimo:

- `OPENALICE_AI_BACKEND`
- la API key del proveedor elegido (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` o `GOOGLE_GENERATIVE_AI_API_KEY`)
- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`

Recomendacion para VPS: usa `vercel-ai-sdk` con API key remota. El backend `claude-code` no viene empaquetado dentro del contenedor.

## 2. Levantar OpenAlice

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

## 3. Verificaciones

```bash
docker compose -f docker-compose.vps.yml ps
curl http://127.0.0.1:3002/api/tools
curl http://127.0.0.1:3002/api/config
```

## Que persiste

Todo el estado de Alice se guarda en `./data`:

- configuracion y perfil de evaluacion
- sesiones web
- event log
- tool calls
- historial de trading
- archivo mensual para estudio posterior

El entrypoint inicializa `./data` si esta vacio usando seeds del repo y luego aplica overrides desde variables de entorno.

## Perfil inicial incluido

El primer arranque siembra automaticamente el perfil de evaluacion de un mes en Alpaca paper para equities USA:

- universo aprobado `SPY QQQ IWM DIA AAPL MSFT NVDA AMZN GOOGL META`
- guardas de `max-position-size=10%` y `cooldown=6h`
- heartbeat durante horario de mercado de Nueva York
- foco en preservacion de capital y decisiones explicables

## Seguridad recomendada

- publica solo el puerto web
- no expongas `MCP`, `MCP Ask` ni el market-data API salvo que realmente los necesites
- coloca Nginx o Caddy delante del puerto web para TLS y autenticacion

## Actualizar en la VPS

```bash
git pull --ff-only
docker compose -f docker-compose.vps.yml up -d --build
```

## Archivo mensual

La base mensual de evaluacion puede regenerarse cuando quieras con:

```bash
python3 scripts/build_monthly_eval_db.py --month 2026-03 --source-root data
```
