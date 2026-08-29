# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 2 — Baseline verified

## Canonical Local Path
`/Users/rjulia/programs/BookForgeAI-Arize`

## Repository
`ricardojjulia/BookForgeAI-Arize` (private)

## Production Upstream
`ricardojjulia/BookForge`

## Zero-Point Commit
`3e9c54c79799530be15569a4e9fd83488f021604`

## Baseline Toolchain
- Node.js: v24.15.0
- npm: 11.13.0
- Git: 2.50.1 (Apple Git-155)
- GitHub CLI: 2.92.0
- BookForge: 2.1.0
- Next.js: 16.3.1
- Vitest: 4.1.11

## Baseline Verification
- npm ci: PASS
- npm audit: 0 vulnerabilities
- npm run build: PASS
- npm test: PASS
- Test files: 109 passed / 109
- Tests: 453 passed / 453
- Working tree after verification: CLEAN

## Pre-existing Warnings
1. Vite warns that `vitest.config.ts` uses ESM syntax while loaded as CommonJS under planned native config loading.
2. Several negative-path tests intentionally emit stderr (Stripe signature failures and mocked GoTrue/Supabase failures) while still passing.
3. `creativewriter-workspace.test.tsx` emits a React/CSS warning: `NaN` is invalid for the `left` CSS property.

These warnings existed before any Arize/OpenTelemetry/OpenInference changes and must not be attributed to observability instrumentation.

## Phoenix
Not installed / not verified yet.

## OpenTelemetry
Not installed.

## OpenInference
Not installed.

## Trace Export
Disabled / not implemented.

## Content Capture
Disabled / not implemented.

## Verified Providers
- [ ] LM Studio
- [ ] OpenAI
- [ ] Anthropic
- [ ] Google
- [ ] OpenRouter

## Verified Workflows
- [ ] Simple managed completion
- [ ] Critic
- [ ] Creation
- [ ] Rewrite
- [ ] Auto Review
- [ ] Retry/fallback

## Next Action
Complete the remaining baseline gate with `npm run lint`, create the immutable baseline tag, then begin the `feat/otel-foundation` branch and Phoenix/OpenTelemetry foundation.
