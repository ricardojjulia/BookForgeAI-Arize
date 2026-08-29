# BookForgeAI-Arize Verification Log

## 2026-08-29 — Phase 1 / Phase 2 Baseline

### Zero-Point Commit
`3e9c54c79799530be15569a4e9fd83488f021604`

### Environment
- Local path: `/Users/rjulia/programs/BookForgeAI-Arize`
- Node.js: v24.15.0
- npm: 11.13.0
- Git: 2.50.1 (Apple Git-155)
- GitHub CLI: 2.92.0
- BookForge: 2.1.0
- Next.js: 16.3.1
- Vitest: 4.1.11

### Commands and Results
- `npm ci` — PASS; 616 packages installed; 617 audited; 0 vulnerabilities.
- `npm run build` — PASS; Next.js optimized production build compiled successfully.
- `npm test` — PASS; 109/109 test files and 453/453 tests passed.
- `git status` — PASS; working tree clean after baseline verification.
- `git rev-parse HEAD` — `3e9c54c79799530be15569a4e9fd83488f021604`.

### Pre-existing Non-blocking Warnings
- Vite native config loader warning for ESM syntax in `vitest.config.ts` loaded as CommonJS.
- Expected stderr from negative-path tests including Stripe signature verification and mocked GoTrue/Supabase failures.
- `creativewriter-workspace.test.tsx` warning: `NaN` is invalid for the `left` CSS style property.

### Gate Status
- Phase 1 repository creation/copy: PASS
- Phase 2 install/build/test baseline: PASS
- Baseline lint: PASS

No OpenTelemetry, OpenInference, Phoenix, or Arize instrumentation had been added at the time of this baseline.

## 2026-08-29 — Phase 3 / Phase 4 Observability Foundation

### Phoenix
- Docker image: `arizephoenix/phoenix:latest`
- Verified Phoenix version: 20.4.0
- HTTP/UI port: 6006
- OTLP gRPC port: 4317
- `/healthz`: PASS (HTTP 200)
- Persistent container name: `bookforge-phoenix`

### Dependency Checkpoint
- `@opentelemetry/api`: 1.9.1
- `@opentelemetry/sdk-node`: 0.221.0
- Initial HTTP exporter: `@opentelemetry/exporter-trace-otlp-http` 0.221.0
- Phoenix transport diagnosis: HTTP/JSON export reached Phoenix but was rejected with `415 Unsupported Media Type` on `/v1/traces`.
- Corrective direction: OTLP HTTP/Protobuf exporter for Phoenix `/v1/traces`.
- `@opentelemetry/resources`: 2.10.0
- `@opentelemetry/semantic-conventions`: 1.43.0
- `@arizeai/openinference-semantic-conventions`: 2.8.0
- Dependency commit after rebase: `8355c8b`
- `npm audit`: 0 vulnerabilities
- `npm run lint`: PASS
- `npm test`: PASS; 109/109 files, 453/453 tests
- `npm run build`: PASS

### Telemetry Bootstrap
- Next.js Node-only registration added.
- NodeSDK initialized behind `BOOKFORGE_OTEL_ENABLED=true`.
- OTLP endpoint: `http://localhost:6006/v1/traces`.
- Phoenix project routing uses the OpenInference project-name resource attribute for `bookforge-ai-arize`.
- Fail-open behavior: PASS.
- Evidence: BookForge remained available on port 4747 with Phoenix stopped, returning HTTP 200; Phoenix was later restarted independently and returned HTTP 200 on `/healthz`.
- Startup log observed with configured Phoenix project.

### Controlled Test Span
- Endpoint: `/api/telemetry/trace-test`
- Request result: PASS
- `ok`: true
- `tracingEnabled`: true
- `spanCreated`: true
- Initial test trace ID: `100844b382f6330133b87f42250c7f28`
- Initial test span ID: `4d1da296b01062a7`
- Server route returned HTTP 200.
- Phoenix ingestion: PASS — Phoenix UI visibly shows project `bookforge-ai-arize` and the manual `bookforge.telemetry.trace-test` span within the Next.js request trace hierarchy.
- Context propagation: PASS — manual BookForge span is nested in the surrounding Next.js request/route trace.
- Exact final trace-ID/attribute screenshot capture remains useful evidence but is no longer blocking transport verification.

### Gate Status
- Gate 3A — Phoenix local backend: PASS
- Gate 3B — telemetry bootstrap + fail-open: PASS
- Gate 4 — first exported trace: PASS

### Next Gate
Instrument the real managed LLM call path with manual OpenInference semantics while preserving privacy defaults and true BookForge provider attribution.
