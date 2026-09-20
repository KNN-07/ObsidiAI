import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const production = process.argv[2] === "production";
export const buildOptions = {
 entryPoints: ["src/main.ts"], bundle: true, format: "cjs", platform: "node", target: "es2022",
 supported: { "dynamic-import": false },
 loader: { ".svg": "text" },
 external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
 inject: ["src/agent/node-fetch.ts"], outfile: "main.js", sourcemap: production ? false : "inline", minify: production, logLevel: "info",
 plugins: [{
  name: "undici-node-globals",
  setup(build) {
   // Obsidian's renderer timers lack unref, performance lacks markResourceTiming,
   // and DOM streams can stall Undici response bodies and cancellation. Bind
   // only Undici to Node APIs, leaving host/UI globals unchanged. The inner
   // block preserves modules' own imports; index's globalThis alias prevents
   // lexical fetch injection rewriting its unused install() assignment.
   build.onLoad({ filter: /[/\\]undici[/\\].*\.js$/ }, async ({ path }) => ({
    contents: `"use strict";\n{
     const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate } = require("node:timers");
     const { performance } = require("node:perf_hooks");
     const { ReadableStream, WritableStream, TransformStream } = require("node:stream/web");
     {
      ${/[/\\]undici[/\\]index\.js$/.test(path) ? "const globalThis = global;" : ""}
      ${await readFile(path, "utf8")}
     }
    }`,
    loader: "js"
   }));
  }
 }]
};
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 const context = await esbuild.context(buildOptions);
 if (production) { await context.rebuild(); await context.dispose(); } else { await context.watch(); }
}
