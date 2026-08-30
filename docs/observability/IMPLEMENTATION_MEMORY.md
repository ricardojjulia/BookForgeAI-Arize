# BookForgeAI-Arize Implementation Memory

## Current Phase
Phase 8 — managed LLM tracing plus Critic, Rewrite, and Auto Review workflow-level OpenInference CHAIN tracing verified in Phoenix.

## Canonical Repository State
- Local path: `/Users/rjulia/programs/BookForgeAI-Arize`
- Private repository: `ricardojjulia/BookForgeAI-Arize`
- Production upstream: `ricardojjulia/BookForge`
- Current branch: `feat/otel-foundation`
- Zero-point commit: `3e9c54c79799530be15569a4e9fd83488f021604`
- Immutable baseline tag: `arize-baseline-verified`

## Baseline Toolchain
- Node.js: v24.15.0
- npm: 11.13.0
- BookForge: 2.1.0
- Next.js: 16.3.1
- Vitest: 4.1.11
- Baseline: lint PASS, build PASS, 109/109 test files and 453/453 tests PASS, npm audit 0 vulnerabilities.

## Pre-existing Non-blocking Warnings
1. Vite native-loader warning for ESM syntax in `vitest.config.ts` loaded as CommonJS.
2. Expected stderr from Stripe signature and mocked GoTrue/Supabase negative-path tests.
3. CreativeWriter React/CSS warning: `NaN` is invalid for the `left` CSS property.

Do not attribute these to observability instrumentation.

## Phoenix
- Image: `arizephoenix/phoenix:latest`
- Verified version: 20.4.0
- Persistent container: `bookforge-phoenix`
- UI: `http://localhost:6006`
- OTLP HTTP/Protobuf endpoint: `http://localhost:6006/v1/traces`
- OTLP gRPC: `localhost:4317`
- Project: `bookforge-ai-arize`
- `/healthz`: HTTP 200

Important transport lesson: OTLP HTTP/JSON reached Phoenix but returned `415 Unsupported Media Type`; the direct `@opentelemetry/exporter-trace-otlp-proto` exporter fixed the transport while retaining the same `/v1/traces` endpoint.

## OpenTelemetry / OpenInference Foundation
Resolved versions:
- `@opentelemetry/api`: 1.9.1
- `@opentelemetry/sdk-node`: 0.221.0
- `@opentelemetry/exporter-trace-otlp-proto`: 0.221.0
- `@opentelemetry/resources`: 2.10.0
- `@opentelemetry/semantic-conventions`: 1.43.0
- `@arizeai/openinference-semantic-conventions`: 2.8.0

Bootstrap:
- `src/instrumentation.ts` performs Node-runtime-only registration.
- `src/instrumentation.node.ts` initializes the NodeSDK fail-open.
- `src/lib/observability/tracer.ts` exposes `bookForgeTracer` and `isBookForgeTracingEnabled()`.
- `BOOKFORGE_OTEL_ENABLED=true` enables tracing.
- Phoenix project routing uses the OpenInference project-name resource attribute.
- Phoenix unavailable at runtime or cold start must never break BookForge; both cases were verified.

## Privacy Defaults
- `BOOKFORGE_TRACE_CONTENT=false`
- `BOOKFORGE_TRACE_USER_IDENTIFIERS=false`
- Custom semantic spans must not contain raw manuscript, prompt, completion, title, author, user identifiers, credentials, cookies, bearer tokens, or API keys.
- Framework/fetch instrumentation may still expose ordinary request URLs; privacy claims apply specifically to BookForge custom semantic spans and events.

## Managed LLM Tracing
Key commits:
- `84b7437` — privacy-safe OpenInference LLM span foundation.
- `504b821` — provider-aware LLM telemetry context.
- `298790a5d027ebec55f77c707b0dfe6ad2b11756` — managed LLM calls traced through OpenInference.

`createManagedChatCompletion()` remains the provider-call chokepoint. It is wrapped by `withBookForgeLlmSpan()` when telemetry context exists.

The wrapper preserves BookForge behavior:
- tracing disabled/failing → provider operation still runs;
- existing credit reservation/reconciliation remains authoritative;
- existing provider retry behavior remains authoritative;
- original provider/model errors are rethrown unchanged;
- existing BookForge billing/model-performance telemetry remains authoritative;
- content capture remains off.

Semantic provider attribution comes from BookForge configuration, not the OpenAI-compatible transport class:
- LM Studio → `provider=lmstudio`, `execution=local`
- OpenAI → `provider=openai`, `execution=cloud`
- Anthropic → `provider=anthropic`, `execution=cloud`
- Google → `provider=google`, `execution=cloud`
- OpenRouter → `provider=openrouter`, `execution=cloud`

Verified providers:
- [x] LM Studio — real managed planning call
- [x] OpenRouter — real planning, Critic, and Rewrite calls
- [ ] OpenAI direct
- [ ] Anthropic direct
- [ ] Google direct

## Reusable Workflow Span
`src/lib/observability/workflow-span.ts` provides `withBookForgeWorkflowSpan()`.

Properties:
- OpenInference kind `CHAIN`.
- Fail-open.
- Activates the workflow span in OTel context so nested calls inherit it.
- Records workflow errors and rethrows the original error.
- Metadata-only; raw content must never be attached.

Known-good workflow wrapper commit lineage begins with:
- `bf06abbc7fd76c1c9fbbe318dc9343cdd523b802` — Critic workflow CHAIN.

## Critic Workflow — VERIFIED
Commit: `bf06abbc7fd76c1c9fbbe318dc9343cdd523b802`.

Observed Phoenix hierarchy:

`bookforge.workflow.critic` CHAIN
→ eight `bookforge.llm.critic` LLM children.

Verified workflow attributes:
- `bookforge.workflow=critic`
- `bookforge.workflow.operation=all-lenses`
- `bookforge.workflow.stage=baseline`
- `bookforge.workflow.unit_count=8`
- `bookforge.workflow.successful_units=8`
- `bookforge.workflow.failed_units=0`
- `openinference.span.kind=CHAIN`

Critic retry/fallback remains separately unverified. A cloud empty-completion retry can switch to `google/gemini-2.5-flash`; do not mark fallback telemetry verified until exercised and inspected.

## Rewrite Workflow — VERIFIED
Commit: `53c4e6139ab913fc4787cde869cb6c2a73aaa437`.

Each chapter-bounded rewrite batch wraps up to five concurrent paragraph model calls in `bookforge.workflow.rewrite`.

Observed Phoenix hierarchy:

`bookforge.workflow.rewrite` CHAIN
→ five `bookforge.llm.rewrite` LLM children in the verified batch.

Verified workflow attributes:
- `bookforge.workflow=rewrite`
- `bookforge.workflow.operation=paragraph-chunk`
- `bookforge.workflow.unit_count=5`
- `bookforge.workflow.fulfilled_calls=5`
- `bookforge.workflow.rejected_calls=0`
- `bookforge.rewrite.strategy=humanized_literary`
- `openinference.span.kind=CHAIN`

Rewrite supports up to three completion attempts and a cloud fallback model `google/gemini-2.5-flash`; fallback semantics remain a later controlled gate.

## Auto Review Workflow — VERIFIED PER INVOCATION
Commit: `7a13c84` — `feat: trace Auto Review orchestration with OpenInference chain`.

Auto Review is a cross-route orchestrator. Its stage order contains 25 entries including analyze, summarize, eight baseline critics, rewrite plan, rewrite execution, auto-accept, drift check, eight post-rewrite critics, critics check, export, and mark-finished.

The route wraps each worker invocation in `bookforge.workflow.auto-review` rather than pretending one in-memory span can survive indefinitely across Vercel checkpoint/self-continuation boundaries.

Verified live Phoenix attributes on a resumed invocation:
- `bookforge.workflow=auto-review`
- `bookforge.workflow.operation=stage-orchestration`
- `bookforge.workflow.unit_count=25`
- `bookforge.auto_review.iteration=2`
- `bookforge.auto_review.completed_stages=11`
- `openinference.span.kind=CHAIN`
- internal HTTP stage calls visibly parented beneath the workflow span
- two workflow events visible

The committed implementation now also records:
- `bookforge.auto_review.start_stage`
- `bookforge.auto_review.end_stage`

Those names replaced the misleading generic `bookforge.workflow.stage` for this long-running orchestrator. The rename itself was not separately live-retested because the parent hierarchy had already been verified.

### Critical Auto Review Control-Flow Lesson
The first wrapper version used:

`await withBookForgeWorkflowSpan(...)`

while checkpoint branches returned `NextResponse.json(...)` from inside the callback. The outer route discarded that callback result and fell through to the final `updateJob({ completed: true })`, falsely completing a checkpointed job.

The committed fix is:

`const workflowResult = await withBookForgeWorkflowSpan(...)`

followed by:

`if (workflowResult) return workflowResult;`

A regression test now proves checkpoint responses do not mark the overall Auto Review job completed.

Behavioral live verification after the fix:
- failed/resumable run restored at `rewrite_execute`;
- wizard resumed from the failed step;
- earlier completed work remained preserved;
- remaining stages ran to completion;
- false-completed-state regression was not observed.

## Current Gate Status
- Gate 3A — Phoenix local backend: PASS
- Gate 3B — telemetry bootstrap/fail-open: PASS
- Gate 4 — first exported trace: PASS
- Gate 5A — privacy-safe LLM span foundation: PASS
- Gate 5B — provider-aware telemetry context: PASS
- Gate 5C — real managed LLM trace: PASS
- Gate 6A — OpenRouter cloud provider verification: PASS
- Gate 7A — Critic managed LLM workflow visibility: PASS
- Gate 7B — Critic workflow CHAIN: PASS
- Gate 7C — Rewrite workflow CHAIN: PASS
- Gate 8A — Auto Review per-invocation orchestration CHAIN: PASS

## Known-Good Checkpoints
- Pre-observability rollback anchor: `arize-baseline-verified` → `3e9c54c79799530be15569a4e9fd83488f021604`
- Managed LLM checkpoint: `298790a5d027ebec55f77c707b0dfe6ad2b11756`
- Critic CHAIN checkpoint: `bf06abbc7fd76c1c9fbbe318dc9343cdd523b802`
- Rewrite CHAIN checkpoint: `53c4e6139ab913fc4787cde869cb6c2a73aaa437`
- Auto Review orchestration checkpoint: `7a13c84`

## Local Working-Tree Caution After Auto Review Commit
After `7a13c84` was pushed, the local workspace still contained separate Auto Review runner work that was intentionally not included in the observability commit:
- modified `src/components/books/auto-review/auto-review-runner.tsx`
- untracked `src/components/books/auto-review/auto-review-runner.test.ts`

The final local full validation reported 110/110 test files and 456/456 tests plus a passing production build, but those counts include that separate uncommitted runner work. Do not attribute the runner files to commit `7a13c84`, and do not discard them accidentally when syncing documentation commits.

## Next Actions
1. Decide whether Gate 8B should correlate Auto Review self-checkpoint/self-continuation invocations into one logical-job trace. Current per-invocation CHAIN semantics are already valid.
2. Add a controlled retry/fallback verification gate for Critic and/or Rewrite, checking attempt/retry/model semantics rather than inferring behavior.
3. Verify direct OpenAI, Anthropic, and Google providers only when actual direct-provider calls are available; OpenRouter calls using those model namespaces do not count as direct-provider verification.
4. Verify the same OTLP design against Arize AX while retaining backend neutrality for future Dynatrace targeting.
