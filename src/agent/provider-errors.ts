const FALLBACK = "Provider request failed. Reconnect in Settings or choose another model.";

/** Classify SDK status metadata or pi's leading HTTP status without exposing upstream bodies. */
export function safeProviderError(error: unknown): string {
 const value = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
 const metadata = value?.$metadata as { httpStatusCode?: unknown } | undefined;
 const response = value?.$response as { statusCode?: unknown } | undefined;
 const statusValue = value?.statusCode ?? value?.status ?? metadata?.httpStatusCode ?? response?.statusCode;
 const message = typeof error === "string" ? error : typeof value?.message === "string" ? value.message : "";
 const status = typeof statusValue === "number" && Number.isInteger(statusValue)
  ? statusValue : Number(/^([45]\d\d)(?::|\s|$)/.exec(message)?.[1]);
 if (status === 401) return "Provider rejected authentication (HTTP 401). Reconnect this provider in Settings.";
 if (status === 403) return "Provider denied access (HTTP 403). Check account permissions and access to the selected model.";
 if (status === 404) return "Provider model endpoint is unavailable (HTTP 404). Choose another model; a listed model may not be deployed or accessible for your account.";
 if (status === 429) return "Provider request limit reached (HTTP 429). Check account quota or try again later.";
 if (status >= 500 && status <= 599) return "Provider service is unavailable (HTTP 5xx). Try again later.";
 return FALLBACK;
}
