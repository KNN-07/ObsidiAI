import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const production = process.argv[2] === "production";
export const buildOptions = {
 entryPoints: ["src/main.ts"], bundle: true, format: "cjs", platform: "node", target: "es2022",
 supported: { "dynamic-import": false },
 external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
 inject: ["src/agent/node-fetch.ts"], outfile: "main.js", sourcemap: production ? false : "inline", minify: production, logLevel: "info",
 plugins: [{
  name: "undici-global-binding",
  setup(build) {
   // Undici exports an unused install() that assigns globalThis.fetch. Keep that
   // module's global binding local so lexical fetch injection does not turn the
   // assignment into an illegal import write. We never invoke install().
   build.onLoad({ filter: /[/\\]undici[/\\]index\.js$/ }, async ({ path }) => ({
    contents: `const globalThis = global;\n${await readFile(path, "utf8")}`,
    loader: "js"
   }));
  }
 }]
};
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
 const context = await esbuild.context(buildOptions);
 if (production) { await context.rebuild(); await context.dispose(); } else { await context.watch(); }
}
