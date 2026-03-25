# CHANGELOG

## [2026-03-24]

### Changes
- Created `AGENTS.md` in the project root with local-only safety, workflow, and VPS protection rules
- Added the mandatory documentation rule so every task/conversation updates `README.md`, `AGENTS.md`, and `CHANGELOG.md` when applicable
- Inspected the local runtime setup, stack, entrypoint, environment files, and build flow before making runtime changes
- Attempted the first local build with `pnpm@10.29.2` without changing project functionality

### Files Modified
- `AGENTS.md`
- `CHANGELOG.md`

### Commands Used
- `ls`
- `cat package.json`
- `sed -n '1,220p' README.md`
- `sed -n '1,240p' Dockerfile`
- `sed -n '1,260p' docker-compose.vps.yml`
- `sed -n '1,220p' src/main.ts`
- `ls ui`
- `rg --files -g '.env*'`
- `node -v && pnpm -v`
- `corepack --version`
- `cat .env.example`
- `cat ui/package.json`
- `npx pnpm@10.29.2 build`
