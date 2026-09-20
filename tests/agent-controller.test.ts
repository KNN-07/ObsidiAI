import { describe, expect, it, vi } from "vitest";
import { createModels, Type, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentController, type ControllerServices } from "../src/agent/controller";
import type { PermissionMode } from "../src/ui/approval-modal";
import { HistoryStore, type ConversationHistory } from "../src/agent/history";

function fixture(options: Parameters<typeof fauxProvider>[0] = {}, history?: ConversationHistory) {
 const faux = fauxProvider({ tokensPerSecond: 100000, ...options });
 const models = createModels(); models.setProvider(faux.provider);
 let pending: ((value: "approve" | "reject") => void) | undefined;
 let approvalListener: (pending: boolean) => void = () => {};
 let mode: PermissionMode = "ask";
 let content = "Status: draft";
 const approvalReady = Promise.withResolvers<void>();
 const services: ControllerServices = {
  notes: { beginRun() {}, endRun() {}, tools: [{ name: "approved_edit", label: "Edit", description: "Test approval boundary", parameters: Type.Object({}), executionMode: "sequential", async execute(_id, _args, signal) {
   let decision: "approve" | "reject";
   if (signal?.aborted || mode === "read-only") decision = "reject";
   else if (mode === "auto-approve-notes") decision = "approve";
   else {
    const gate = Promise.withResolvers<"approve" | "reject">();
    pending = gate.resolve; approvalListener(true); approvalReady.resolve();
    signal?.addEventListener("abort", () => gate.resolve("reject"), { once: true });
    decision = await gate.promise;
    pending = undefined; approvalListener(false);
   }
   const outcome = decision === "approve" && !signal?.aborted ? "applied" : "rejected";
   if (outcome === "applied") content = "Status: reviewed";
   return { content: [{ type: "text", text: outcome }], details: { outcome } };
  } }] },
  metadata: { tools: [] }, plugins: { tools: [] },
  skills: { tools: [], async beginRun(names) { if (names.includes("unknown")) throw new Error("Unknown skill: unknown"); }, endRun() {}, catalogPrompt() { return ""; }, async selectedContext() { return ""; } },
  approvals: {
   get mode() { return mode; },
   setMode(next) {
    if (next !== "ask" && next !== "read-only" && next !== "auto-approve-notes") throw new Error("Invalid permission mode.");
    if (pending) throw new Error("An approval is pending.");
    mode = next;
   },
   cancelAll() { pending?.("reject"); }, subscribe(listener) { approvalListener = listener; return () => {}; }
  }
 };
 const controller = new AgentController({ models, streamFn: models.streamSimple.bind(models) }, services, history);
 return { faux, controller, approvalReady: approvalReady.promise, approve: () => pending?.("approve"), content: () => content, configure: () => controller.configure(faux.provider.id, faux.models[0].id) };
}

describe("real Agent conversation settlement", () => {
 it("restores real tool context across reload and deletes without resurrecting on disposal", async () => {
  let bytes = "";
  const adapter = { async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path: string, value: string) { bytes = value; } };
  const first = fixture({}, new HistoryStore(adapter, "history.json")); await first.configure();
  first.controller.setPermissionMode("auto-approve-notes");
  first.faux.setResponses([fauxAssistantMessage(fauxToolCall("approved_edit", {})), fauxAssistantMessage("Applied.")]);
  await first.controller.send("Review it");
  const [saved] = await first.controller.listHistory();
  await first.controller.reset();
  expect(first.controller.timeline).toEqual([]);
  await first.controller.dispose();
  const next = fixture({}, new HistoryStore(adapter, "history.json")); await next.configure();
  await next.controller.openConversation(saved!.id);
  expect(next.controller.permissionMode).toBe("ask");
  expect(next.controller.timeline.some(t => t.kind === "tool" && t.status === "applied")).toBe(true);
  let context: Context | undefined;
  const stream = next.controller.runtime.streamFn;
  next.controller.runtime.streamFn = (model, value, options) => { context = value; return stream(model, value, options); };
  // Reopen binds the capturing stream to a fresh real Agent.
  await next.controller.openConversation(saved!.id);
  next.faux.setResponses([fauxAssistantMessage("I remember.")]);
  await next.controller.send("What changed?");
  expect(context?.messages.some(m => m.role === "toolResult")).toBe(true);
  expect(context?.messages.some(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall"))).toBe(true);
  await next.controller.deleteConversation(saved!.id);
  await next.controller.dispose();
  expect(await new HistoryStore(adapter, "history.json").list()).toEqual([]);
  expect(bytes).not.toContain("Review it");
  expect(bytes).not.toContain("auto-approve-notes");
 });
 it("refuses history switching during approval and archives the cancelled run only after settlement", async () => {
  let bytes = "";
  const history = new HistoryStore({ async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path, value) { bytes = value; } }, "history.json");
  const f = fixture({}, history); await f.configure();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("approved_edit", {}))]);
  const run = f.controller.send("Pending change"); await f.approvalReady;
  await expect(f.controller.openConversation("other")).rejects.toThrow("settle");
  await expect(f.controller.deleteConversation("other")).rejects.toThrow("settle");
  await f.controller.reset(); await run; f.approve();
  expect(f.content()).toBe("Status: draft");
  expect(f.controller.timeline).toEqual([]);
  const [saved] = await history.list();
  expect((await history.get(saved!.id)).timeline.some(t => t.kind === "tool" && t.complete)).toBe(true);
  await f.controller.dispose();
 });
 it("retains unsaved context when archiving fails and reports the failure", async () => {
  let bytes = ""; let fail = true;
  const history = new HistoryStore({ async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path, value) { if (fail) throw new Error("Disk full"); bytes = value; } }, "history.json");
  const f = fixture({}, history); await f.configure();
  f.faux.setResponses([fauxAssistantMessage("Keep this answer.")]);
  await expect(f.controller.send("Keep this question.")).rejects.toThrow("could not be saved");
  await expect(f.controller.reset()).rejects.toThrow("could not be saved");
  expect(f.controller.timeline.some(t => t.text === "Keep this answer.")).toBe(true);
  expect(f.controller.idle).toBe(true);
  fail = false; await f.controller.reset();
  const [saved] = await history.list();
  await f.controller.openConversation(saved!.id);
  f.faux.setResponses([(context: Context) => {
   expect(JSON.stringify(context.messages)).toContain("Keep this question.");
   expect(JSON.stringify(context.messages)).toContain("Keep this answer.");
   return fauxAssistantMessage("Recovered context.");
  }]);
  await f.controller.send("Continue.");
  await f.controller.dispose();
 });
 it("waits for an in-flight deletion during disposal without writing the deleted chat back", async () => {
  let bytes = ""; let block = false;
  const entered = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
  const history = new HistoryStore({ async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path, value) { if (block) { entered.resolve(); await gate.promise; } bytes = value; } }, "history.json");
  const f = fixture({}, history); await f.configure();
  f.faux.setResponses([fauxAssistantMessage("Saved.")]); await f.controller.send("Question");
  const [saved] = await history.list(); block = true;
  const deletion = f.controller.deleteConversation(saved!.id); await entered.promise;
  let disposed = false; const disposal = f.controller.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false);
  gate.resolve(); await deletion; await disposal;
  expect(await history.list()).toEqual([]);
  expect(bytes).not.toContain("Question");
 });
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
 it("locks permission changes throughout running, approval, stopping, and disposal", async () => {
  const f = fixture(); await f.configure();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("approved_edit", {}))]);
  const run = f.controller.send("Review it");
  expect(() => f.controller.setPermissionMode("auto-approve-notes")).toThrow("Wait for the current run");
  await f.approvalReady;
  expect(() => f.controller.setPermissionMode("read-only")).toThrow("Wait for the current run");
  const stop = f.controller.stop();
  expect(() => f.controller.setPermissionMode("auto-approve-notes")).toThrow("Wait for the current run");
  await stop; await run;
  expect(f.content()).toBe("Status: draft");
  f.controller.setPermissionMode("read-only");
  await f.controller.dispose();
  expect(() => f.controller.setPermissionMode("ask")).toThrow("Wait for the current run");
 });
 it("changes note permissions without losing conversation and restores approval on New conversation", async () => {
  const f = fixture(); await f.configure();
  const requests: Context["messages"][] = [];
  const propose = (context: Context) => {
   requests.push(structuredClone(context.messages));
   return fauxAssistantMessage(fauxToolCall("approved_edit", {}));
  };
  f.faux.setResponses([propose, fauxAssistantMessage("Read-only preserved it"), propose, fauxAssistantMessage("Automatic edit applied")]);
  f.controller.setPermissionMode("read-only");
  await f.controller.send("Remember this question");
  expect(f.content()).toBe("Status: draft");
  expect(f.controller.timeline.find(item => item.kind === "tool")?.status).toBe("rejected");
  f.controller.setPermissionMode("auto-approve-notes");
  await f.configure();
  await f.controller.send("Now edit it");
  expect(f.content()).toBe("Status: reviewed");
  expect(f.controller.timeline.filter(item => item.kind === "tool").map(item => item.status)).toEqual(["rejected", "applied"]);
  expect(requests[1]!.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join(""))).toEqual(["Remember this question", "Now edit it"]);
  await f.controller.reset();
  expect(f.controller.timeline).toEqual([]);
  f.faux.setResponses([propose, fauxAssistantMessage("Approved in a new conversation")]);
  const run = f.controller.send("A fresh conversation");
  await f.approvalReady;
  expect(f.controller.state).toBe("awaiting-approval");
  expect(requests[2]!.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join(""))).toEqual(["A fresh conversation"]);
  f.approve(); await run;
  await f.controller.dispose();
 });
 it("settles an active run before resetting permission to ask", async () => {
  const f = fixture(); await f.configure();
  f.controller.setPermissionMode("auto-approve-notes");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.faux.setResponses([async () => {
   entered.resolve(); await release.promise; return fauxAssistantMessage("Stopped");
  }]);
  const run = f.controller.send("Wait at the provider");
  await entered.promise;
  const reset = f.controller.reset();
  expect(f.controller.permissionMode).toBe("auto-approve-notes");
  release.resolve(); await reset; await run;
  expect(f.controller.permissionMode).toBe("ask");
  expect(f.controller.idle).toBe(true);
  expect(f.controller.timeline).toEqual([]);
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
 it("shows attachment labels while preserving model context across history reload", async () => {
  let bytes = "";
  const adapter = { async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path: string, value: string) { bytes = value; } };
  const history = new HistoryStore(adapter, "history.json");
  const f = fixture({}, history); await f.configure();
  f.controller.addAttachment("Projects/Alpha.md", "PRIVATE NOTE BODY");
  f.controller.services.skills.selectedContext = async () => "PRIVATE SKILL BODY";
  f.controller.selectSkill("review");
  f.faux.setResponses([(context: Context) => {
   expect(JSON.stringify(context.messages)).toContain("PRIVATE NOTE BODY");
   expect(JSON.stringify(context.messages)).toContain("PRIVATE SKILL BODY");
   return fauxAssistantMessage("Reviewed.");
  }]);
  await f.controller.send("Review the attached note.");
  expect(f.controller.timeline.find(t => t.kind === "user")).toMatchObject({
   text: "Review the attached note.", attachmentPaths: ["Projects/Alpha.md"], skillNames: ["review"],
  });
  expect(JSON.stringify(f.controller.timeline)).not.toMatch(/PRIVATE NOTE BODY|PRIVATE SKILL BODY/);
  const [saved] = await history.list(); await f.controller.dispose();
  const next = fixture({}, new HistoryStore(adapter, "history.json")); await next.configure();
  await next.controller.openConversation(saved!.id);
  expect(next.controller.timeline.find(t => t.kind === "user")).toMatchObject({ text: "Review the attached note.", attachmentPaths: ["Projects/Alpha.md"] });
  next.faux.setResponses([(context: Context) => {
   expect(JSON.stringify(context.messages)).toContain("PRIVATE NOTE BODY");
   return fauxAssistantMessage("Remembered.");
  }]);
  await next.controller.send("Continue.");
  expect(next.controller.timeline.filter(t => t.kind === "user").at(-1)).toMatchObject({ text: "Continue." });
  await next.controller.dispose();
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
