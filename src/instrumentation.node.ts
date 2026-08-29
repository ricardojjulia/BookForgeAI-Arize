import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

declare global {
  // Prevent duplicate SDK initialization during development reloads.
  // eslint-disable-next-line no-var
  var __bookforgeOtelStarted: boolean | undefined;
}

function isEnabled() {
  return process.env.BOOKFORGE_OTEL_ENABLED === "true";
}

function debug(message: string, error?: unknown) {
  if (process.env.BOOKFORGE_OTEL_DEBUG !== "true") return;

  if (error !== undefined) {
    console.warn(`[BookForge OTEL] ${message}`, error);
    return;
  }

  console.info(`[BookForge OTEL] ${message}`);
}

if (isEnabled() && !globalThis.__bookforgeOtelStarted) {
  globalThis.__bookforgeOtelStarted = true;

  try {
    const endpoint =
      process.env.BOOKFORGE_OTEL_ENDPOINT ||
      "http://localhost:6006/v1/traces";

    const traceExporter = new OTLPTraceExporter({
      url: endpoint,
    });

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]:
          process.env.BOOKFORGE_OTEL_SERVICE_NAME || "bookforge-ai-arize",
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "unknown",
        "bookforge.project":
          process.env.BOOKFORGE_OTEL_PROJECT_NAME || "bookforge-ai-arize",
      }),
      traceExporter,
    });

    sdk.start();
    debug(`started; exporting traces to ${endpoint}`);
  } catch (error) {
    // Fail open: observability must never prevent BookForge from starting.
    globalThis.__bookforgeOtelStarted = false;
    debug(
      "failed to initialize; BookForge will continue without tracing",
      error,
    );
  }
}
