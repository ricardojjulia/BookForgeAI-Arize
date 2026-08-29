# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 4 — Phoenix verified; OpenTelemetry/OpenInference dependencies installed and validated

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
- Docker image: `arizephoenix/phoenix:latest`
- Verified Phoenix server version: 20.4.0
- UI / HTTP endpoint: `http://localhost:6006`
- OTLP gRPC: `localhost:4317`
- `/healthz`: PASS (HTTP 200)
- Container: `bookforge-phoenix`

## OpenTelemetry / OpenInference Resolved Versions
- `@opentelemetry/api`: 1.9.1
- `@opentelemetry/sdk-node`: 0.221.0
- `@opentelemetry/exporter-trace-otlp-http`: 0.221.0
- `@opentelemetry/resources`: 2.10.0
- `@opentelemetry/semantic-conventions`: 1.43.0
- `@arizeai/openinference-semantic-conventions`: 2.8.0

The mixed OpenTelemetry package version families are expected: API packages use the 1.x line, stable SDK/resource packages use the 2.x line, while some Node/exporter/instrumentation packages retain the 0.x release line. The resolved dependency tree is deduped and internally consistent.

## Post-Dependency Verification
- npm install: PASS
- npm audit: 0 vulnerabilities
- npm run lint: PASS
- npm test: PASS
- Test files: 109 passed / 109
- Tests: 453 passed / 453
- npm run build: PASS
- Modified files after install: `package.json`, `package-lock.json` only

## Trace Export
Not initialized yet.

## Content Capture
Not implemented; policy remains OFF by default.

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
The immutable rollback anchor is the pre-observability commit tagged `arize-baseline-verified`. The current feature branch begins after documentation-only commits that record baseline evidence and project memory.

## Next Action
1. Commit `package.json` and `package-lock.json` as the dependency checkpoint.
2. Pull this memory update locally after committing/pushing dependencies, resolving order safely if necessary.
3. Add environment variables and Next.js `src/instrumentation.ts` plus Node-only telemetry initialization.
4. Verify BookForge starts with Phoenix available.
5. Verify BookForge starts with Phoenix unavailable (fail-open test).
6. Re-run lint, tests and build before touching managed LLM calls.
