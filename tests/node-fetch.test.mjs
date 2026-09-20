import { expect, it } from "vitest";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { buildOptions } from "../esbuild.config.mjs";

it("streams and aborts with renderer globals without changing host fetch, timers or performance", async () => {
 const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.write("first");
  if (request.url === "/complete") response.end("second");
 });
 server.listen(0, "127.0.0.1");
 await once(server, "listening");
 const address = server.address();
 const timers = new Map();
 let nextTimer = 0;
 const browserTimer = (schedule) => (callback, delay, ...args) => {
  const id = ++nextTimer;
  timers.set(id, schedule(callback, delay, ...args));
  return id;
 };
 const clearBrowserTimer = id => {
  clearTimeout(timers.get(id));
  clearInterval(timers.get(id));
  timers.delete(id);
 };
 const hostFetch = () => { throw new Error("Renderer fetch must not be used"); };
 const hostPerformance = { now: () => performance.now() };
 // Renderer stream implementations are not Node's transport primitives. Fail
 // immediately if a request accidentally uses them instead of hanging a test.
 class HostStream { constructor() { throw new Error("Incompatible host stream"); } }
 const context = {};
 for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (name !== "globalThis" && name !== "global") context[name] = globalThis[name];
 }
 Object.assign(context, {
  module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
  fetch: hostFetch, performance: hostPerformance,
  ReadableStream: HostStream, WritableStream: HostStream, TransformStream: HostStream,
  setTimeout: browserTimer(setTimeout), setInterval: browserTimer(setInterval),
  clearTimeout: clearBrowserTimer, clearInterval: clearBrowserTimer
 });
 context.global = context;
 const hostSetInterval = context.setInterval;
 try {
  const result = await build({ ...buildOptions, entryPoints: ["src/agent/node-fetch.ts"], write: false, sourcemap: false, minify: false, logLevel: "silent" });
  runInNewContext(result.outputFiles[0].text, context);
  const fetch = context.module.exports.fetch;
  const url = `http://127.0.0.1:${address.port}`;
  const complete = await fetch(`${url}/complete`);
  expect(await complete.text()).toBe("firstsecond");
  const abort = new AbortController();
  const streaming = await fetch(`${url}/stream`, { signal: abort.signal });
  const reader = streaming.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  abort.abort();
  await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  expect(context.fetch).toBe(hostFetch);
  expect(context.performance).toBe(hostPerformance);
  expect(context.setInterval).toBe(hostSetInterval);
  expect(context.ReadableStream).toBe(HostStream);
 } finally {
  for (const id of timers.keys()) clearBrowserTimer(id);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
}, 15000);
