export async function fetchJson<T = unknown>(
  path: string,
  options: RequestInit = {},
  label = "request",
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network request failed";
    const online =
      typeof navigator === "undefined" || navigator.onLine ? "browser reports online" : "browser reports offline";
    throw new Error(`${label} could not reach ${path}. ${detail}. ${online}. Refresh the page and try again.`);
  }

  const result = await readResponseJson(response, label);
  if (!response.ok) {
    const message =
      result && typeof result === "object" && "error" in result
        ? String((result as { error: unknown }).error)
        : `${label} failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return result as T;
}

async function readResponseJson(response: Response, label: string) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || looksLikeHtmlDocument(text)) {
      return {
        error: `${label} failed with HTTP ${response.status}: the server returned an HTML error page instead of JSON. Check server logs for the underlying error.`,
      };
    }
    return { error: text.slice(0, 500) };
  }
}

function looksLikeHtmlDocument(text: string) {
  const trimmed = text.trimStart().slice(0, 200).toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || trimmed.startsWith("&lt;!doctype html") || trimmed.startsWith("&lt;html");
}
