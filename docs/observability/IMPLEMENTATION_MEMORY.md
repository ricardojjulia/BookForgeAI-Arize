# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 6 — managed LLM tracing verified end to end; ready for cloud-provider and workflow tracing expansion

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
Resolved foundation versions:
- `@opentelemetry/api`: 1.9.1
- `@opentelemetry/sdk-node`: 0.221.0
- `@opentelemetry/exporter-trace-otlp-proto`: 0.221.0 direct exporter
- `@opentelemetry/resources`: 2.10.0
- `@opentelemetry/semantic-conventions`: 1.43.0
- `@arizeai/openinference-semantic-conventions`: 2.8.0

Important transport lesson:
- `@opentelemetry/exporter-trace-otlp-http` reached Phoenix but produced `415 Unsupported Media Type` on `/v1/traces` in this setup.
- The corrected direct exporter is `@opentelemetry/exporter-trace-otlp-proto`, using OTLP HTTP/Protobuf to `http://localhost:6006/v1/traces`.
- Exporter correction commit: `16e440e`.

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
- Phoenix UI visibly shows project `bookforge-ai-arize`, surrounding Next.js request/route spans, and manual child span `bookforge.telemetry.trace-test`.
- Context propagation is proven end to end.
- Gate 4 first exported trace: PASS.

## Managed LLM Tracing Architecture
Key commits:
- `84b7437` — privacy-safe OpenInference LLM span foundation.
- `504b821` — provider-aware LLM telemetry context.
- `298790a5d027ebec55f77c707b0dfe6ad2b11756` — trace managed LLM calls with OpenInference.

`createManagedChatCompletion()` is the managed provider-call chokepoint.

The logical flow is now:

BookForge route/workflow → model selection → provider-aware telemetry context → `withBookForgeLlmSpan()` → provider invocation → existing BookForge outcome/cost/reconciliation telemetry.

The wrapper preserves existing BookForge semantics:
- credit reservation remains before cloud provider invocation;
- the deprecated-temperature retry remains the same logical request;
- existing `recordModelCallEvent()` behavior remains intact;
- credit reconciliation remains intact;
- tracing failures remain fail-open;
- original provider/model errors remain authoritative;
- raw prompt/completion capture remains off.

## Provider Attribution
Provider identity comes from BookForge configuration, not from the OpenAI SDK transport class.

Supported semantic mapping:
- LM Studio → `provider=lmstudio`, `execution=local`
- OpenAI → `provider=openai`, `execution=cloud`
- Anthropic → `provider=anthropic`, `execution=cloud`
- Google → `provider=google`, `execution=cloud`
- OpenRouter → `provider=openrouter`, `execution=cloud`

This is required because BookForge intentionally uses OpenAI-compatible transport semantics for multiple providers.

## Live Managed LLM Verification
Verified using the real Create Book → Concept path:

`POST /api/creation/concept` → task `planning` → managed model selection → `createManagedChatCompletion()` → local LM Studio.

Phoenix showed a real nested child span:
- span name: `bookforge.llm.planning`
- Phoenix kind: `llm`
- status: OK
- approximate latency: 36.5 s
- parent trace: real `POST /api/creation/concept` request

Verified semantic attributes:
- `bookforge.task = planning`
- `bookforge.provider = lmstudio`
- `bookforge.execution = local`
- `bookforge.attempt = 1`
- `bookforge.retry = false`
- `bookforge.model.requested = qwen/qwen3.6-35b-a3b`
- `bookforge.model.resolved = qwen/qwen3.6-35b-a3b`
- `openinference.span.kind = LLM`
- `llm.model_name = qwen/qwen3.6-35b-a3b`

Verified usage/size attributes:
- `bookforge.message_count = 1`
- `bookforge.input_chars = 1660`
- `bookforge.estimated_input_tokens = 519`
- `bookforge.max_output_tokens = 3500`
- `bookforge.output_chars = 1518`
- `bookforge.output_words = 231`
- `llm.token_count.prompt = 439`
- `llm.token_count.completion = 3499`
- `llm.token_count.total = 3938`

Verified event:
- `provider.attempt`
- `attempt = 1`
- `model = qwen/qwen3.6-35b-a3b`

## Trace Export
Operational end to end:
BookForge → OpenTelemetry API → NodeSDK → OTLP HTTP/Protobuf → Phoenix project `bookforge-ai-arize`.

## Content Capture / Privacy
Disabled by default.
- `BOOKFORGE_TRACE_CONTENT=false`
- `BOOKFORGE_TRACE_USER_IDENTIFIERS=false`
- Live managed LLM span showed metadata/counts only.
- Phoenix input/output columns for the custom LLM span did not display raw prompt or generated completion.
- No custom attribute/event contained manuscript content, book title, author identity, user ID, API key, cookie, bearer token, or Supabase credential.

## Verified Providers
- [x] LM Studio — real managed `planning` call verified in Phoenix
- [ ] OpenAI
- [ ] Anthropic
- [ ] Google
- [ ] OpenRouter

## Verified Workflows
- [x] Simple managed completion / managed-call boundary
- [ ] Critic
- [x] Creation — Concept planning path verified
- [ ] Rewrite
- [ ] Auto Review
- [ ] Retry/fallback

## Gate Status
- Gate 3A — Phoenix local backend: PASS
- Gate 3B — telemetry bootstrap + fail-open: PASS
- Gate 4 — first exported trace: PASS
- Gate 5A — privacy-safe LLM span foundation: PASS
- Gate 5B — provider-aware telemetry context: PASS
- Gate 5C — real managed LLM trace: PASS

## Known-Good Checkpoints
- Immutable pre-observability rollback anchor: `arize-baseline-verified` → `3e9c54c79799530be15569a4e9fd83488f021604`
- Verified managed LLM instrumentation checkpoint: `298790a5d027ebec55f77c707b0dfe6ad2b11756`

## Next Action
1. Keep the verified managed-call boundary stable.
2. Verify one real cloud-provider call in Phoenix and confirm BookForge-native provider attribution plus `execution=cloud`.
3. Verify retry/fallback event behavior through a controlled or naturally reproducible path without changing billing semantics.
4. Add higher-level CHAIN/workflow spans so multi-call operations show parent/child structure above individual LLM spans.
5. Expand workflow verification to Critic, Rewrite, and Auto Review.
6. Preserve metadata-only privacy defaults and fail-open behavior.
7. After broader local Phoenix verification, prove the same OTLP design against Arize AX and keep the exporter backend-neutral for future Dynatrace targeting.
