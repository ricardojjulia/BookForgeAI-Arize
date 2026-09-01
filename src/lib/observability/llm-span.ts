import {
  SpanStatusCode,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import type { LlmProvider } from "@/lib/types";
import { bookForgeTracer, isBookForgeTracingEnabled } from "@/lib/observability/tracer";

/**
 * Provider identity must come from BookForge configuration, never from the
 * OpenAI SDK class. BookForge intentionally uses that SDK as a transport for
 * LM Studio, OpenAI, Anthropic, Google, and OpenRouter.
 */
export type BookForgeLlmProvider = Extract<
  LlmProvider,
  "lmstudio" | "openai" | "anthropic" | "google" | "openrouter"
>;

export type BookForgeLlmExecution = "local" | "cloud";

/**
 * Serializable metadata only. Never place Span/Tracer instances, clients,
 * Supabase objects, API keys, or raw prompt/completion content here.
 */
export type BookForgeLlmTraceContext = {
  task: string;
  model: string;
  provider?: BookForgeLlmProvider;
  execution?: BookForgeLlmExecution;
  requestedModel?: string;
  workflow?: string;
  attempt?: number;
  retry?: boolean;

  /**
   * Stable BookForge user identifier.
   *
   * Emitted only when BOOKFORGE_TRACE_USER_IDENTIFIERS=true.
   */
  userId?: string;
};

export type BookForgeLlmInputMetrics = {
  messageCount?: number;
  inputChars?: number;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;

  /**
   * Raw model input supplied by the managed LLM caller.
   *
   * This value is emitted only when BOOKFORGE_TRACE_CONTENT=true.
   * The tracing layer owns that policy so callers never need to duplicate it.
   */
  inputValue?: unknown;
};

export type BookForgeLlmResultMetrics = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  outputChars?: number;
  outputWords?: number;
  costUsdMicros?: number;
  validationOutcome?: string;
  resolvedModel?: string;
  finishReason?: string;

  /**
   * Raw model output.
   *
   * This value is emitted only when BOOKFORGE_TRACE_CONTENT=true.
   */
  outputValue?: string;
};

export type BookForgeLlmSpanController = {
  /** Record a retry/attempt/error breadcrumb without creating a second logical LLM span. */
  addEvent(name: string, attributes?: Attributes): void;
  /** Add completion/result metrics after the provider responds. */
  setResult(metrics: BookForgeLlmResultMetrics): void;
};

/**
 * Runs one logical BookForge LLM operation inside an OpenInference-compatible
 * LLM span. The wrapper is deliberately fail-open: observability errors must
 * never prevent or alter the underlying model call, and the original model
 * error is always rethrown unchanged.
 *
 * Raw input/output content is optional and is emitted only when
 * BOOKFORGE_TRACE_CONTENT=true. Metadata, usage, model identity, and status
 * remain available regardless of the content-capture setting.
 */
export async function withBookForgeLlmSpan<T>(
  context: BookForgeLlmTraceContext,
  operation: (span: BookForgeLlmSpanController) => Promise<T>,
  inputMetrics: BookForgeLlmInputMetrics = {},
): Promise<T> {
  if (!isBookForgeTracingEnabled()) {
    return operation(noopController);
  }

  let span: Span | undefined;

  try {
    span = bookForgeTracer.startSpan(`bookforge.llm.${sanitizeSpanSegment(context.task)}`, {
      attributes: compactAttributes({
        "openinference.span.kind": "LLM",
        "bookforge.task": context.task,
        "bookforge.workflow": context.workflow,
        "bookforge.provider": context.provider,
        "bookforge.execution": context.execution,
        "bookforge.model.requested": context.requestedModel,
        "bookforge.model.resolved": context.model,
        "bookforge.attempt": context.attempt,
        "bookforge.retry": context.retry,
        "bookforge.user_id":
          traceUserIdentifiers() ? context.userId : undefined,
        "bookforge.message_count": inputMetrics.messageCount,
        "bookforge.input_chars": inputMetrics.inputChars,
        "bookforge.estimated_input_tokens": inputMetrics.estimatedInputTokens,
        "bookforge.max_output_tokens": inputMetrics.maxOutputTokens,
        "llm.model_name": context.model,

        // OpenInference document-level input semantics. Raw content is
        // intentionally gated here rather than at individual call sites.
        "input.value": traceContent()
          ? safeJsonStringify(inputMetrics.inputValue)
          : undefined,
        "input.mime_type":
          traceContent() && inputMetrics.inputValue !== undefined
            ? "application/json"
            : undefined,
      }),
    });
  } catch {
    // Tracer/span creation failures must not affect BookForge execution.
    return operation(noopController);
  }

  const controller = createController(span);

  try {
    const result = await operation(controller);
    safeSpanCall(() => span?.setStatus({ code: SpanStatusCode.OK }));
    return result;
  } catch (error) {
    safeSpanCall(() => {
      if (error instanceof Error) span?.recordException(error);
      span?.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    throw error;
  } finally {
    safeSpanCall(() => span?.end());
  }
}

function createController(span: Span): BookForgeLlmSpanController {
  return {
    addEvent(name, attributes) {
      safeSpanCall(() => span.addEvent(name, attributes));
    },
    setResult(metrics) {
      safeSpanCall(() => {
        span.setAttributes(
          compactAttributes({
            "llm.model_name": metrics.resolvedModel,
            "llm.token_count.prompt": metrics.promptTokens,
            "llm.token_count.completion": metrics.completionTokens,
            "llm.token_count.total": metrics.totalTokens,
            "bookforge.output_chars": metrics.outputChars,
            "bookforge.output_words": metrics.outputWords,
            "bookforge.cost_usd_micros": metrics.costUsdMicros,
            "bookforge.validation": metrics.validationOutcome,
            "bookforge.finish_reason": metrics.finishReason,

            // Phoenix / OpenInference first-class LLM output semantics.
            "output.value":
              traceContent() && metrics.outputValue !== undefined
                ? metrics.outputValue
                : undefined,
            "output.mime_type":
              traceContent() && metrics.outputValue !== undefined
                ? "text/plain"
                : undefined,
          }),
        );
      });
    },
  };
}

const noopController: BookForgeLlmSpanController = {
  addEvent() {},
  setResult() {},
};

function compactAttributes(
  values: Record<string, string | number | boolean | undefined>,
): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
  );
}

function traceContent() {
  return process.env.BOOKFORGE_TRACE_CONTENT === "true";
}

function traceUserIdentifiers() {
  return process.env.BOOKFORGE_TRACE_USER_IDENTIFIERS === "true";
}

function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;

  try {
    return JSON.stringify(value);
  } catch {
    // Content capture is advisory. Serialization problems must never affect
    // the underlying BookForge model operation.
    return undefined;
  }
}

function sanitizeSpanSegment(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "unknown";
}

function safeSpanCall(call: () => void) {
  try {
    call();
  } catch {
    // Observability is advisory. Never let span bookkeeping break BookForge.
  }
}
