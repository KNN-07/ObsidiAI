import type * as Undici from "undici";
let implementation: typeof Undici.fetch | undefined;
const nodeFetch: typeof globalThis.fetch = (input, init) => {
 implementation ??= (require("undici") as typeof Undici).fetch;
 return implementation(input as Parameters<typeof implementation>[0], init as Parameters<typeof implementation>[1]) as unknown as ReturnType<typeof globalThis.fetch>;
};
export { nodeFetch as fetch, nodeFetch as "globalThis.fetch" };
