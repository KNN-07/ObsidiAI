import { describe, expect, it } from "vitest";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentController, type ControllerServices } from "../src/agent/controller";

function fixture() {
 const faux = fauxProvider({ tokensPerSecond: 100000 });
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
});
