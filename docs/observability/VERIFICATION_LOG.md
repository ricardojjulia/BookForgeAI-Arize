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
- Remaining baseline check before instrumentation: `npm run lint`

No OpenTelemetry, OpenInference, Phoenix, or Arize instrumentation had been added at the time of this baseline.
