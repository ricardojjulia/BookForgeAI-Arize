# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 4 — telemetry bootstrap verified; first controlled span created; Phoenix ingestion match pending

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
- OTLP HTTP traces endpoint: `http://localhost:6006/v1/traces`
- OTLP gRPC: `localhost:4317`
- `/healthz`: PASS (HTTP 200)
- Persistent container: `bookforge-phoenix`

## OpenTelemetry / OpenInference Resolved Versions
- `@opentelemetry/api`: 1.9.1
- `@opentelemetry/sdk-node`: 0.221.0
- `@opentelemetry/exporter-trace-otlp-http`: 0.221.0
- `@opentelemetry/resources`: 2.10.0
- `@opentelemetry/semantic-conventions`: 1.43.0
- `@arizeai/openinference-semantic-conventions`: 2.8.0

The mixed OpenTelemetry package version families are expected: API packages use the 1.x line, stable SDK/resource packages use the 2.x line, while some Node/exporter/instrumentation packages retain the 0.x release line. The resolved dependency tree is deduped and internally consistent.

## Post-Dependency Verification
- Dependency commit after rebase: `8355c8b`
- npm install: PASS
- npm audit: 0 vulnerabilities
- npm run lint: PASS
- npm test: PASS
- Test files: 109 passed / 109
- Tests: 453 passed / 453
- npm run build: PASS

## Telemetry Bootstrap
- `src/instrumentation.ts`: Node-runtime-only dynamic import.
- `src/instrumentation.node.ts`: fail-open NodeSDK initialization.
- `BOOKFORGE_OTEL_ENABLED=true` successfully starts telemetry.
- Development duplicate-start guard enabled.
- Startup log verified: `[BookForge OTEL] started; exporting traces to http://localhost:6006/v1/traces`.
- Phoenix unavailable while BookForge is running: PASS; BookForge returned HTTP 200.
- Phoenix unavailable during BookForge cold start: PASS; BookForge started and returned HTTP 200.
- Phoenix restart independent of BookForge: PASS.

## Controlled Trace Test
- `src/lib/observability/tracer.ts` provides the BookForge tracer.
- `/api/telemetry/trace-test` creates a safe, content-free CHAIN span.
- API response verified:
  - `ok=true`
  - `tracingEnabled=true`
  - `spanCreated=true`
  - trace ID `100844b382f6330133b87f42250c7f28`
  - span ID `4d1da296b01062a7`
- Phoenix ingestion / matching trace ID in UI: NOT YET VERIFIED.

## Trace Export
Initialized and operational at the SDK level. End-to-end Phoenix ingestion is pending direct UI verification of the controlled test trace.

## Content Capture
Disabled by default.
- `BOOKFORGE_TRACE_CONTENT=false`
- `BOOKFORGE_TRACE_USER_IDENTIFIERS=false`
- Test span contains no manuscript, prompt, completion, title, author identity, API key, cookie, token, or Supabase service-role key.

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

## Gate Status
- Gate 3A — Phoenix local backend: PASS
- Gate 3B — telemetry bootstrap + fail-open: PASS
- Gate 4 — first exported trace: PARTIAL PASS; span creation confirmed, Phoenix trace-ID match pending

## Known-Good Baseline
The immutable rollback anchor is the pre-observability commit tagged `arize-baseline-verified`. The current feature branch begins after documentation-only commits that record baseline evidence and project memory.

## Next Action
1. Pull latest documentation updates from `origin/feat/otel-foundation` after stopping the local dev server if necessary.
2. In Phoenix UI, locate `bookforge.telemetry.trace-test`.
3. Verify trace ID matches `100844b382f6330133b87f42250c7f28`.
4. Verify safe diagnostic attributes are present and no content/secrets are captured.
5. Re-run lint/build if any code changes occur.
6. Once Gate 4 is PASS, begin manual OpenInference instrumentation of the managed LLM call path without OpenAI auto-instrumentation.
