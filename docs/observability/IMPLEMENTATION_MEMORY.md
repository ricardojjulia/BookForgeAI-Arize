# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 7 — LM Studio, OpenRouter, Creation, and Critic managed LLM tracing verified; next target is workflow-level CHAIN tracing

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
- span: `bookforge.llm.planning`
- provider: `lmstudio`
- execution: `local`
- model: `qwen/qwen3.6-35b-a3b`
- prompt/completion/total tokens: 439 / 3499 / 3938
- event: `provider.attempt`, attempt 1

## Live Managed LLM Verification — OpenRouter
Verified using a real Create Book → Concept cloud call:
- span: `bookforge.llm.planning`
- provider: `openrouter`
- execution: `cloud`
- requested/resolved model: `anthropic/claude-haiku-4.5`
- prompt/completion/total tokens: 468 / 1280 / 1748
- event: `provider.attempt`, attempt 1

This proves provider and model family are separate dimensions. OpenRouter is the provider even when the model identifier is namespaced to Anthropic.

## Critic Workflow Verification
A real drafted-book Critic run was executed through OpenRouter using the existing managed LLM instrumentation.

Phoenix visibly showed eight `bookforge.llm.critic` spans in the same trace, matching BookForge's eight supported Critic lenses. This is the first verified multi-call BookForge workflow.

Selected verified example span:
- span name: `bookforge.llm.critic`
- status: OK
- latency: approximately 7 s
- provider: `openrouter`
- execution: `cloud`
- task: `critic`
- attempt: 1
- retry: false
- requested/resolved model shown as `google/gemini-2.5-flash-lite`
- OpenInference kind: `LLM`
- message count: 1
- estimated input tokens: 897
- output chars: 7327
- output words: 1023
- total token count shown by Phoenix: 2183
- event count: 1 (`provider.attempt`)
- same trace showed outbound OpenRouter chat-completion HTTP calls

The custom Critic LLM span remained metadata-only; no raw manuscript content was visible in the displayed custom attributes.

## Critic Workflow Architecture
`runCriticLens()` selects models with `task: "critic"` and calls `createManagedChatCompletion()` through the verified managed LLM boundary.

The Critic path supports up to two completion attempts. On cloud execution, an empty first completion can retry using fallback model `google/gemini-2.5-flash`. That fallback remains a useful later verification target.

## Trace Export
Operational end to end:
BookForge → OpenTelemetry API → NodeSDK → OTLP HTTP/Protobuf → Phoenix project `bookforge-ai-arize`.

## Content Capture / Privacy
Disabled by default.
- `BOOKFORGE_TRACE_CONTENT=false`
- `BOOKFORGE_TRACE_USER_IDENTIFIERS=false`
- Live managed LLM spans show metadata/counts rather than raw prompt/completion content.
- No custom attribute/event should contain manuscript content, book title, author identity, user ID, API key, cookie, bearer token, or Supabase credential.

## Verified Providers
- [x] LM Studio — real managed `planning` call verified in Phoenix
- [ ] OpenAI
- [ ] Anthropic direct
- [ ] Google direct
- [x] OpenRouter — real managed cloud `planning` and `critic` calls verified in Phoenix

## Verified Workflows
- [x] Simple managed completion / managed-call boundary
- [x] Critic — eight LLM spans visible in one real Critic trace
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
- Gate 7A — Critic workflow managed LLM verification: PASS

## Known-Good Checkpoints
- Immutable pre-observability rollback anchor: `arize-baseline-verified` → `3e9c54c79799530be15569a4e9fd83488f021604`
- Verified managed LLM instrumentation checkpoint: `298790a5d027ebec55f77c707b0dfe6ad2b11756`

## Next Action
1. Add one privacy-safe higher-level CHAIN/workflow span around a multi-call Critic run, while leaving `createManagedChatCompletion()` as the LLM child-span boundary.
2. Verify in Phoenix that the Critic workflow span parents the individual `bookforge.llm.critic` spans.
3. Use that workflow wrapper pattern for Rewrite and Auto Review.
4. Keep retry/fallback verification as a separate controlled gate.
5. Preserve metadata-only privacy defaults and fail-open behavior.
6. After broader Phoenix verification, prove the same OTLP design against Arize AX and retain backend neutrality for future Dynatrace targeting.
