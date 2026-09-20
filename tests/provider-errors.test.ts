import { describe, expect, it } from "vitest";
import { safeProviderError } from "../src/agent/provider-errors";

describe("safe provider failure reporting", () => {
 it("explains an unavailable model without exposing the upstream response", () => {
  const message = safeProviderError('404 {"detail":"private-account-value", "authorization":"secret-key"}');
  expect(message).toContain("Choose another model");
  expect(message).toContain("HTTP 404");
  expect(message).not.toMatch(/private-account-value|secret-key|authorization/);
 });
 it("prefers structured status and does not interpret arbitrary numbers inside errors", () => {
  expect(safeProviderError({ status: 401, message: "404 private-response" })).toContain("authentication");
  expect(safeProviderError(new Error("token-404-secret"))).toBe(safeProviderError(undefined));
  expect(safeProviderError({ status: 402, message: "secret subscription body" })).toBe(safeProviderError(undefined));
 });
 it("distinguishes access, quota, and service failures using fixed messages", () => {
  expect(safeProviderError({ $metadata: { httpStatusCode: 403 } })).toContain("permissions");
  expect(safeProviderError("429: sensitive account quota")).toContain("quota");
  expect(safeProviderError({ $response: { statusCode: 503 } })).toContain("Try again later");
 });
});
