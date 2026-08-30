import { trace } from "@opentelemetry/api";

export const bookForgeTracer = trace.getTracer(
  "bookforge.ai",
  process.env.npm_package_version,
);

export function isBookForgeTracingEnabled() {
  return process.env.BOOKFORGE_OTEL_ENABLED === "true";
}
