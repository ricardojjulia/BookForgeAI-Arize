# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 3 — OpenTelemetry foundation branch active

## Canonical Local Path
`/Users/rjulia/programs/BookForgeAI-Arize`

## Repository
`ricardojjulia/BookForgeAI-Arize` (private)

## Production Upstream
`ricardojjulia/BookForge`

## Zero-Point Commit
`3e9c54c79799530be15569a4e9fd83488f021604`

## Immutable Baseline Tag
`arize-baseline-verified` → `3e9c54c79799530be15569a4e9fd83488f021604`

## Current Branch
`feat/otel-foundation`

## Branch Start Commit
`0bbc3bec1a371fe58e15bee089db218d736bb888`

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
- npm run lint: PASS
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

## Known-Good Baseline
The immutable rollback anchor is the pre-observability commit tagged `arize-baseline-verified`. The current feature branch begins after two documentation-only commits that record baseline evidence and project memory.

## Next Action
1. Pull this updated memory commit locally.
2. Verify Docker availability.
3. Start Arize Phoenix locally.
4. Verify Phoenix UI and OTLP ports.
5. Install only the OpenTelemetry/OpenInference foundation dependencies.
6. Re-run lint, tests and build before adding instrumentation code.
