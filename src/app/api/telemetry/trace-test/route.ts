import { SpanStatusCode } from "@opentelemetry/api";
import { NextResponse } from "next/server";

import {
  bookForgeTracer,
  isBookForgeTracingEnabled,
} from "@/lib/observability/tracer";

export const runtime = "nodejs";

export async function GET() {
  if (process.env.BOOKFORGE_OTEL_DEBUG !== "true") {
    return NextResponse.json(
      { error: "Trace test endpoint is disabled." },
      { status: 404 },
    );
  }

  if (!isBookForgeTracingEnabled()) {
    return NextResponse.json({
      ok: true,
      tracingEnabled: false,
      spanCreated: false,
    });
  }

  return bookForgeTracer.startActiveSpan("bookforge.telemetry.trace-test", (span) => {
    try {
      span.setAttribute("openinference.span.kind", "CHAIN");
      span.setAttribute("bookforge.test", true);
      span.setAttribute("bookforge.component", "telemetry");
      span.setAttribute("bookforge.operation", "trace-test");
      span.setStatus({ code: SpanStatusCode.OK });

      return NextResponse.json({
        ok: true,
        tracingEnabled: true,
        spanCreated: true,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      });
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
