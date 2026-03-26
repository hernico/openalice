# CHANGELOG

## [2026-03-25]

### Changes
- Added a safe Alpaca paper smoke test script that generates `trade_updates` without fill risk (create + cancel a small limit order)
- Documented the smoke test usage in `README.md`
- Ran the smoke test on the VPS container and confirmed `alpaca-eval` captured trade updates to JSONL
- Verified the March monthly archive now contains `3` `alpaca_trade_updates` rows for the smoke test (`pending_new`, `new`, `canceled`)
- Added a one-week VPS timer/service wrapper to run the smoke test once per weekday and log each execution
- Deployed the timer on the VPS and confirmed the first scheduled-week run was logged under `data/archive/smoke-tests/alpaca-smoke-week.log`

### Files Modified
- `README.md`
- `CHANGELOG.md`
- `scripts/alpaca_trade_updates_smoke_test.mjs`
- `scripts/run_alpaca_smoke_week.sh`
- `deploy/vps/systemd/openalice-alpaca-smoke-week.service`
- `deploy/vps/systemd/openalice-alpaca-smoke-week.timer`

### Commands Used
- `rsync -az --delete --exclude .git/ --exclude node_modules/ --exclude .env --exclude data/ ... root@104.131.30.195:/srv/bots/openalice-paper-eval/`
- `ssh root@104.131.30.195 "docker cp ... openalice-paper-eval-openalice-1:/app/scripts/alpaca_trade_updates_smoke_test.mjs"`
- `ssh root@104.131.30.195 "docker exec -w /app openalice-paper-eval-openalice-1 node scripts/alpaca_trade_updates_smoke_test.mjs"`
- `ssh root@104.131.30.195 "curl -s http://127.0.0.1:3002/api/alpaca-eval/status"`
- `ssh root@104.131.30.195 "tail -n 2 /srv/bots/openalice-paper-eval/data/alpaca-eval/trade-updates/2026-03-25.jsonl"`
- `ssh root@104.131.30.195 "python3 -c ... select count(*) from alpaca_trade_updates ..."`
- `ssh root@104.131.30.195 "python3 -c ... select ts, event, symbol, side, status, qty, filled_qty from alpaca_trade_updates ..."`
- `ssh root@104.131.30.195 "install -m 0644 ... openalice-alpaca-smoke-week.* /etc/systemd/system/ ..."`
- `ssh root@104.131.30.195 "systemctl daemon-reload && systemctl enable --now openalice-alpaca-smoke-week.timer"`
- `ssh root@104.131.30.195 "systemctl status --no-pager openalice-alpaca-smoke-week.timer"`
- `ssh root@104.131.30.195 "systemctl start openalice-alpaca-smoke-week.service"`
