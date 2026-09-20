import { describe, expect, it, vi } from "vitest";
import { createModels, Type, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentController, type ControllerServices } from "../src/agent/controller";

function fixture(options: Parameters<typeof fauxProvider>[0] = {}) {
 const faux = fauxProvider({ tokensPerSecond: 100000, ...options });
 const models = createModels(); models.setProvider(faux.provider);
 let pending: ((value: "approve" | "reject") => void) | undefined;
 let approvalListener: (pending: boolean) => void = () => {};
 let content = "Status: draft";
 const approvalReady = Promise.withResolvers<void>();
 const services: ControllerServices = {
  notes: { beginRun() {}, endRun() {}, tools: [{ name: "approved_edit", label: "Edit", description: "Test approval boundary", parameters: Type.Object({}), executionMode: "sequential", async execute(_id, _args, signal) {
   const gate = Promise.withResolvers<"approve" | "reject">();
   pending = gate.resolve; approvalListener(true); approvalReady.resolve();
   signal?.addEventListener("abort", () => gate.resolve("reject"), { once: true });
   const decision = await gate.promise;
   approvalListener(false);
   const outcome = decision === "approve" && !signal?.aborted ? "applied" : "rejected";
   if (outcome === "applied") content = "Status: reviewed";
   return { content: [{ type: "text", text: outcome }], details: { outcome } };
  } }] },
  metadata: { tools: [] }, plugins: { tools: [] },
  skills: { tools: [], async beginRun(names) { if (names.includes("unknown")) throw new Error("Unknown skill: unknown"); }, endRun() {}, catalogPrompt() { return ""; }, async selectedContext() { return ""; } },
  approvals: { cancelAll() { pending?.("reject"); }, subscribe(listener) { approvalListener = listener; return () => {}; } }
 };
 const controller = new AgentController({ models, streamFn: models.streamSimple.bind(models) }, services);
 return { faux, controller, approvalReady: approvalReady.promise, approve: () => pending?.("approve"), content: () => content, configure: () => controller.configure(faux.provider.id, faux.models[0].id) };
}

describe("real Agent conversation settlement", () => {
 it("waits for approval and preserves applied results after settlement", async () => {
  const f = fixture(); await f.configure();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("approved_edit", {})), fauxAssistantMessage("Changed after approval.")]);
  const run = f.controller.send("Review it");
  await f.approvalReady;
  expect(f.content()).toBe("Status: draft");
  await expect(f.controller.send("overlap")).rejects.toThrow();
  f.approve(); await run;
  expect(f.content()).toBe("Status: reviewed");
  expect(f.controller.timeline.some(t => t.kind === "tool" && t.status === "applied")).toBe(true);
  expect(f.controller.timeline.some(t => t.text.includes("Changed after approval."))).toBe(true);
  expect(f.controller.idle).toBe(true);
  await f.controller.dispose();
 });
 it("settles Stop and ignores a late approval, then accepts another prompt", async () => {
  const f = fixture(); await f.configure();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("approved_edit", {}))]);
  const run = f.controller.send("Review it");
  await f.approvalReady;
  await f.controller.stop(); f.approve(); await run;
  expect(f.content()).toBe("Status: draft"); expect(f.controller.idle).toBe(true);
  f.faux.setResponses([fauxAssistantMessage("Next run works")]); await f.controller.send("Hello");
  expect(f.controller.timeline.some(t => t.text === "Next run works")).toBe(true);
  await f.controller.dispose();
 });
 it("keeps attachments on failed setup or unknown slash skills and clears only upon submission", async () => {
  const f = fixture(); f.controller.addAttachment("A.md", "Private note");
  await expect(f.controller.send("Hello")).rejects.toThrow(); expect(f.controller.attachments).toHaveLength(1);
  await f.configure(); await expect(f.controller.send("/skill:unknown")).rejects.toThrow("Unknown skill");
  expect(f.controller.attachments).toHaveLength(1); expect(f.controller.idle).toBe(true);
  f.faux.setResponses([fauxAssistantMessage("Done")]); await f.controller.send("Hello");
  expect(f.controller.attachments).toHaveLength(0);
  await f.controller.reset(); expect(f.controller.timeline).toEqual([]);
  await f.controller.dispose();
 });
 it("surfaces assistant error stopReason without exposing upstream error bodies", async () => {
  const f = fixture(); await f.configure(); f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "secret-token-upstream" })]);
  await f.controller.send("Hello");
  expect(f.controller.timeline.some(t => t.kind === "error" && t.text.includes("Reconnect"))).toBe(true);
  expect(JSON.stringify(f.controller.timeline)).not.toContain("secret-token-upstream");
  expect(f.controller.idle).toBe(true); await f.controller.dispose();
 });
 it("sends selected reasoning through the real Agent and clamps model switches without losing conversation", async () => {
  const f = fixture({ models: [{ id: "reasoner", reasoning: true }, { id: "plain", reasoning: false }, { id: "constrained", reasoning: true }] });
  f.faux.models[2]!.thinkingLevelMap = { off: null, minimal: null, low: null, high: null, xhigh: null, max: null };
  const requests: { model: string; reasoning: SimpleStreamOptions["reasoning"]; messages: Context["messages"] }[] = [];
  f.faux.setResponses(Array.from({ length: 4 }, () => (context: Context, options: SimpleStreamOptions | undefined, _state: unknown, model: { id: string }) => {
   requests.push({ model: model.id, reasoning: options?.reasoning, messages: structuredClone(context.messages) });
   return fauxAssistantMessage(`Answer ${requests.length}`);
  }));
  await f.controller.configure(f.faux.provider.id, "reasoner", "high");
  await f.controller.send("Remember the first question");
  f.controller.setThinkingLevel("low");
  await f.controller.send("Continue with less effort");
  await f.controller.configure(f.faux.provider.id, "plain", "high");
  expect(f.controller.thinkingLevels).toEqual(["off"]);
  expect(() => f.controller.setThinkingLevel("high")).toThrow("does not support");
  await f.controller.send("Continue without reasoning");
  await f.controller.configure(f.faux.provider.id, "constrained", "max");
  expect(f.controller.thinkingLevels).toEqual(["medium"]);
  expect(f.controller.thinkingLevel).toBe("medium");
  await f.controller.send("Finish with constrained reasoning");
  expect(requests.map(({ model, reasoning }) => ({ model, reasoning }))).toEqual([
   { model: "reasoner", reasoning: "high" }, { model: "reasoner", reasoning: "low" },
   { model: "plain", reasoning: undefined }, { model: "constrained", reasoning: "medium" },
  ]);
  expect(requests[3]!.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join(""))).toEqual([
   "Remember the first question", "Continue with less effort", "Continue without reasoning", "Finish with constrained reasoning",
  ]);
  expect(requests[3]!.messages.filter(message => message.role === "assistant").map(message => message.content.filter(block => block.type === "text").map(block => block.text).join(""))).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
  expect(f.controller.timeline.filter(item => item.kind === "assistant").map(item => item.text)).toEqual(["Answer 1", "Answer 2", "Answer 3", "Answer 4"]);
  await f.controller.dispose();
 });
 it("rejects effort changes before configuration and during a gated real request", async () => {
  const f = fixture({ models: [{ id: "reasoner", reasoning: true }, { id: "plain" }] });
  expect(() => f.controller.setThinkingLevel("low")).toThrow("Select an available model");
  await f.controller.configure(f.faux.provider.id, "reasoner", "high");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: { model: string; reasoning: SimpleStreamOptions["reasoning"] }[] = [];
  f.faux.setResponses([
   async (_context, options, _state, model) => {
    requests.push({ model: model.id, reasoning: options?.reasoning }); entered.resolve();
    await release.promise; return fauxAssistantMessage("First settled");
   },
   (_context, options, _state, model) => {
    requests.push({ model: model.id, reasoning: options?.reasoning }); return fauxAssistantMessage("Second settled");
   },
  ]);
  const run = f.controller.send("Wait at the provider");
  await entered.promise;
  try {
   expect(() => f.controller.setThinkingLevel("low")).toThrow("Wait for the current run");
   await f.controller.configure(f.faux.provider.id, "plain", "off");
  } finally { release.resolve(); await run; }
  await f.controller.send("Keep the original model and effort");
  expect(requests).toEqual([{ model: "reasoner", reasoning: "high" }, { model: "reasoner", reasoning: "high" }]);
  await f.controller.dispose();
 });
 it("ignores an obsolete availability result even if the cancelled probe resolves late", async () => {
  const f = fixture({ models: [{ id: "reasoner", reasoning: true }, { id: "plain" }] });
  const stale = Promise.withResolvers<typeof f.faux.models>();
  const available = vi.spyOn(f.controller.runtime.models, "getAvailable").mockImplementationOnce(() => stale.promise);
  const first = f.controller.configure(f.faux.provider.id, "reasoner", "high");
  await f.controller.configure(f.faux.provider.id, "plain", "max");
  stale.resolve(f.faux.models); await first;
  available.mockRestore();
  expect(f.controller.thinkingLevels).toEqual(["off"]);
  const requests: { model: string; reasoning: SimpleStreamOptions["reasoning"] }[] = [];
  f.faux.setResponses([(_context, options, _state, model) => {
   requests.push({ model: model.id, reasoning: options?.reasoning }); return fauxAssistantMessage("Current selection");
  }]);
  await f.controller.send("Use the latest selection");
  expect(requests).toEqual([{ model: "plain", reasoning: undefined }]);
  await f.controller.dispose();
 });
});
