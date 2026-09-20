import type * as Undici from "undici";
let implementation: typeof Undici.fetch | undefined;
const nodeFetch: typeof globalThis.fetch = (input, init) => {
 implementation ??= (require("undici") as typeof Undici).fetch;
 return implementation(input as Undici.RequestInfo, init as Undici.RequestInit) as unknown as Promise<Response>;
};
export { nodeFetch as fetch, nodeFetch as "globalThis.fetch" };
