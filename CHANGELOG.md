# CHANGELOG

## [2026-03-25]

### Changes
- Added a safe Alpaca paper smoke test script that generates `trade_updates` without fill risk (create + cancel a small limit order)
- Documented the smoke test usage in `README.md`
- Ran the smoke test on the VPS container and confirmed `alpaca-eval` captured trade updates to JSONL

### Files Modified
- `README.md`
- `CHANGELOG.md`
- `scripts/alpaca_trade_updates_smoke_test.mjs`

### Commands Used
- `rsync -az --delete --exclude .git/ --exclude node_modules/ --exclude .env --exclude data/ ... root@104.131.30.195:/srv/bots/openalice-paper-eval/`
- `ssh root@104.131.30.195 "docker cp ... openalice-paper-eval-openalice-1:/app/scripts/alpaca_trade_updates_smoke_test.mjs"`
- `ssh root@104.131.30.195 "docker exec -w /app openalice-paper-eval-openalice-1 node scripts/alpaca_trade_updates_smoke_test.mjs"`
- `ssh root@104.131.30.195 "curl -s http://127.0.0.1:3002/api/alpaca-eval/status"`
- `ssh root@104.131.30.195 "tail -n 2 /srv/bots/openalice-paper-eval/data/alpaca-eval/trade-updates/2026-03-25.jsonl"`
