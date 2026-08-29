export async function register() {
  // BookForge's observability SDK is Node-only. Avoid loading Node-specific
  // OpenTelemetry packages in an Edge runtime if one is introduced later.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
