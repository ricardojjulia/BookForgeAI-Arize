# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 6 — LM Studio and OpenRouter managed LLM tracing verified; next target is Critic workflow verification

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

## Live Managed LLM Verification — LM Studio
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

## Live Managed LLM Verification — OpenRouter
A second real Create Book → Concept request was executed through OpenRouter cloud mode.

Phoenix showed:
- span name: `bookforge.llm.planning`
- provider request in the same trace to `https://openrouter.ai/api/v1/...`
- `bookforge.provider = openrouter`
- `bookforge.execution = cloud`
- `bookforge.task = planning`
- `bookforge.attempt = 1`
- `bookforge.retry = false`
- requested/resolved model: `anthropic/claude-haiku-4.5`
- `openinference.span.kind = LLM`
- `llm.model_name = anthropic/claude-haiku-4.5`
- prompt tokens: 468
- completion tokens: 1280
- total tokens: 1748
- input chars: 1660
- estimated input tokens: 519
- output chars: 5378
- output words: 713
- max output tokens: 3500
- event `provider.attempt`, attempt 1, model `anthropic/claude-haiku-4.5`

This is important proof that provider and model family are separate dimensions. OpenRouter is the provider even when the model identifier is namespaced to Anthropic. The semantic provider comes from BookForge configuration, not the OpenAI-compatible SDK transport.

## Critic Workflow Architecture
`runCriticLens()` uses `selectAndPrepareActiveModel()` with `task: "critic"` and calls `createManagedChatCompletion()` through the already-verified managed LLM boundary.

The critic path supports up to two completion attempts. On cloud execution, an empty first completion can retry using fallback model `google/gemini-2.5-flash`. That fallback is a useful later verification target, but the immediate next gate is a normal successful Critic lens run with no code changes.

## Trace Export
Operational end to end:
BookForge → OpenTelemetry API → NodeSDK → OTLP HTTP/Protobuf → Phoenix project `bookforge-ai-arize`.

## Content Capture / Privacy
Disabled by default.
- `BOOKFORGE_TRACE_CONTENT=false`
- `BOOKFORGE_TRACE_USER_IDENTIFIERS=false`
- Live managed LLM spans showed metadata/counts only.
- Phoenix input/output columns for the custom LLM spans did not display raw prompt or generated completion.
- No custom attribute/event contained manuscript content, book title, author identity, user ID, API key, cookie, bearer token, or Supabase credential.

## Verified Providers
- [x] LM Studio — real managed `planning` call verified in Phoenix
- [ ] OpenAI
- [ ] Anthropic
- [ ] Google
- [x] OpenRouter — real managed cloud `planning` call verified in Phoenix

## Verified Workflows
- [x] Simple managed completion / managed-call boundary
- [ ] Critic
- [x] Creation — Concept planning path verified locally and through OpenRouter
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
- Gate 6A — OpenRouter cloud provider verification: PASS

## Known-Good Checkpoints
- Immutable pre-observability rollback anchor: `arize-baseline-verified` → `3e9c54c79799530be15569a4e9fd83488f021604`
- Verified managed LLM instrumentation checkpoint: `298790a5d027ebec55f77c707b0dfe6ad2b11756`

## Next Action
1. Keep the verified managed-call boundary stable; no instrumentation code changes are required for the next test.
2. Run one real BookForge Critic lens on an existing drafted book.
3. Confirm Phoenix shows `bookforge.llm.critic` with correct provider/execution/model/token metadata and no raw manuscript content.
4. Record Critic workflow verification.
5. Later verify the Critic empty-completion fallback path or another controlled retry/fallback path.
6. Expand workflow verification to Rewrite and Auto Review.
7. Preserve metadata-only privacy defaults and fail-open behavior.
8. After broader local Phoenix verification, prove the same OTLP design against Arize AX and keep the exporter backend-neutral for future Dynatrace targeting.
