import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ App: class {}, Modal: class {}, ButtonComponent: class {}, DropdownComponent: class {} }));
import { PendingAuthPrompt } from "../src/ui/auth-modal";

describe("native authentication prompt settlement", () => {
 it("cancels only the manual fallback when a callback succeeds", async () => {
  const login = new AbortController();
  const manual = new AbortController();
  const cleanup = vi.fn();
  const pending = new PendingAuthPrompt([login.signal, manual.signal], cleanup);
  const rejected = expect(pending.promise).rejects.toMatchObject({ name: "AbortError" });
  manual.abort();
  await rejected;
  expect(login.signal.aborted).toBe(false);
  pending.accept("late-code");
  expect(cleanup).toHaveBeenCalledTimes(1);
  const next = new PendingAuthPrompt([login.signal], () => {});
  next.accept("callback-success");
  await expect(next.promise).resolves.toBe("callback-success");
 });
 it("whole-login cancellation rejects every prompt and late input cannot approve", async () => {
  const login = new AbortController();
  const first = new PendingAuthPrompt([login.signal], () => {});
  const second = new PendingAuthPrompt([login.signal], () => {});
  const outcomes = Promise.allSettled([first.promise, second.promise]);
  login.abort();
  first.accept("late-secret");
  second.accept("late-selection");
  for (const outcome of await outcomes) {
   expect(outcome.status).toBe("rejected");
   if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ name: "AbortError" });
  }
 });
 it("honors signals already aborted before rendering and leaves accepted answers settled", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = new PendingAuthPrompt([controller.signal], () => {});
  await expect(cancelled.promise).rejects.toMatchObject({ name: "AbortError" });
  const accepted = new PendingAuthPrompt([], () => {});
  accepted.accept("option-id");
  accepted.cancel();
  await expect(accepted.promise).resolves.toBe("option-id");
 });
});
