---
name: deploy
description: Run all checks then deploy to production
disable-model-invocation: true
---

Deploy to production with full pre-flight checks.

## Pre-flight
1. `git status` — no uncommitted changes
2. `npm run lint` — zero warnings
3. `npm run build` — clean build
4. `npm test` — all tests green
5. `npx playwright test` — e2e passing

## Deploy
6. `git push origin main`
7. Wait for CI/CD pipeline to complete

## Post-deploy verification
8. Hit production URL, check homepage loads
9. Verify API health endpoint returns 200
10. Check error monitoring for spikes

## If anything fails
- Do NOT force push or skip checks
- Fix the issue, re-run all checks
