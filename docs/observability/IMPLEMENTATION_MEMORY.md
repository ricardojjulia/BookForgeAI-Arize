# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 5 — first end-to-end Phoenix trace verified; ready for real managed LLM instrumentation

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
- Verified Phoenix project: `bookforge-ai-arize`

## OpenTelemetry / OpenInference
Resolved foundation versions initially included:
- `@opentelemetry/api`: 1.9.1
- `@opentelemetry/sdk-node`: 0.221.0
- `@opentelemetry/resources`: 2.10.0
- `@opentelemetry/semantic-conventions`: 1.43.0
- `@arizeai/openinference-semantic-conventions`: 2.8.0

Important transport lesson:
- `@opentelemetry/exporter-trace-otlp-http` reached Phoenix but produced `415 Unsupported Media Type` on `/v1/traces` in this setup.
- Phoenix ingestion requires the OTLP HTTP/Protobuf transport for this endpoint; the exporter dependency/import should therefore use the `-proto` package before the foundation checkpoint is finalized.

## Telemetry Bootstrap
- `src/instrumentation.ts`: Node-runtime-only dynamic import.
- `src/instrumentation.node.ts`: fail-open NodeSDK initialization.
- `BOOKFORGE_OTEL_ENABLED=true` successfully starts telemetry.
- Development duplicate-start guard enabled.
- Phoenix project routing uses the OpenInference project-name resource attribute.
- Phoenix unavailable while BookForge is running: PASS; BookForge returned HTTP 200.
- Phoenix unavailable during BookForge cold start: PASS; BookForge started and returned HTTP 200.
- Phoenix restart independent of BookForge: PASS.

## Controlled Trace Test
- `src/lib/observability/tracer.ts` provides the BookForge tracer.
- `/api/telemetry/trace-test` creates a safe, content-free CHAIN span.
- API response verified with real trace/span IDs.
- Phoenix UI now visibly shows:
  - project `bookforge-ai-arize`
  - surrounding Next.js request/route spans
  - manual child span `bookforge.telemetry.trace-test`
- Context propagation is therefore proven end to end.
- Gate 4 first exported trace: PASS.

## Trace Export
Operational end to end: BookForge → OpenTelemetry API → NodeSDK → OTLP → Phoenix.

## Content Capture
Disabled by default.
- `BOOKFORGE_TRACE_CONTENT=false`
- `BOOKFORGE_TRACE_USER_IDENTIFIERS=false`
- Diagnostic span contains no manuscript, prompt, completion, title, author identity, API key, cookie, token, or Supabase service-role key.

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
- Gate 4 — first exported trace: PASS

## Known-Good Baseline
The immutable rollback anchor is the pre-observability commit tagged `arize-baseline-verified`. The current feature branch begins after documentation-only commits that record baseline evidence and project memory.

## Next Action
1. Finalize the local exporter dependency/import on OTLP HTTP/Protobuf and run lint/tests/build.
2. Commit/push that corrected foundation checkpoint.
3. Begin manual OpenInference instrumentation of `createManagedChatCompletion()` without OpenAI SDK auto-instrumentation.
4. Preserve BookForge-native provider attribution (`lmstudio`, `openai`, `anthropic`, `google`, `openrouter`) and local/cloud execution semantics.
5. Keep raw content and user identifiers disabled by default.
