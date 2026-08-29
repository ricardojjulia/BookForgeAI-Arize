import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import {
  bookForgeTracer,
  isBookForgeTracingEnabled,
} from "@/lib/observability/tracer";

export type BookForgeWorkflowTraceContext = {
  workflow: string;
  operation?: string;
  stage?: string;
  unitCount?: number;
};

export type BookForgeWorkflowSpanController = {
  addEvent(name: string, attributes?: Attributes): void;
  setAttributes(attributes: Attributes): void;
};

/**
 * Runs a BookForge workflow inside an OpenInference-compatible CHAIN span.
 *
 * The wrapper is fail-open:
 * - tracing disabled -> workflow runs normally
 * - span creation failure -> workflow runs normally
 * - span bookkeeping failure -> workflow continues
 * - workflow errors are recorded and rethrown unchanged
 *
 * Raw manuscript/prompt/completion content must never be added here.
 */
export async function withBookForgeWorkflowSpan<T>(
  workflowContext: BookForgeWorkflowTraceContext,
  operation: (span: BookForgeWorkflowSpanController) => Promise<T>,
): Promise<T> {
  if (!isBookForgeTracingEnabled()) {
    return operation(noopController);
  }

  let span: Span;

  try {
    span = bookForgeTracer.startSpan(
      `bookforge.workflow.${sanitizeSpanSegment(workflowContext.workflow)}`,
      {
        attributes: compactAttributes({
          "openinference.span.kind": "CHAIN",
          "bookforge.workflow": workflowContext.workflow,
          "bookforge.workflow.operation": workflowContext.operation,
          "bookforge.workflow.stage": workflowContext.stage,
          "bookforge.workflow.unit_count": workflowContext.unitCount,
        }),
      },
    );
  } catch {
    return operation(noopController);
  }

  const controller = createController(span);
  const activeContext = trace.setSpan(otelContext.active(), span);

  try {
    const result = await otelContext.with(
      activeContext,
      () => operation(controller),
    );

    safeSpanCall(() => span.setStatus({ code: SpanStatusCode.OK }));
    return result;
  } catch (error) {
    safeSpanCall(() => {
      if (error instanceof Error) span.recordException(error);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    throw error;
  } finally {
    safeSpanCall(() => span.end());
  }
}

function createController(span: Span): BookForgeWorkflowSpanController {
  return {
    addEvent(name, attributes) {
      safeSpanCall(() => span.addEvent(name, attributes));
    },

    setAttributes(attributes) {
      safeSpanCall(() => span.setAttributes(attributes));
    },
  };
}

const noopController: BookForgeWorkflowSpanController = {
  addEvent() {},
  setAttributes() {},
};

function compactAttributes(
  values: Record<string, string | number | boolean | undefined>,
): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string | number | boolean] =>
        entry[1] !== undefined,
    ),
  );
}

function sanitizeSpanSegment(value: string) {
  return (
    value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") ||
    "unknown"
  );
}

function safeSpanCall(call: () => void) {
  try {
    call();
  } catch {
    // Observability is advisory. Never let span bookkeeping break BookForge.
  }
}
