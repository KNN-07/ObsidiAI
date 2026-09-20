import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { fetch as nodeFetch } from "./node-fetch";

export interface ProviderRuntime {
 models: MutableModels;
 streamFn: StreamFn;
}

export function createProviderRuntime(credentials: CredentialStore): ProviderRuntime {
 registerBunOAuthFlows();
 setBedrockProviderModule(bedrockProviderModule);
 const models = builtinModels({ credentials });
 const streamFn: StreamFn = (model, context, options) => {
  const { fetch: _fetch, ...forwarded } = options ?? {};
  const ambient = model.api === "google-generative-ai" || model.api === "google-vertex" || model.api === "bedrock-converse-stream";
  return models.streamSimple(model, context, { ...forwarded, ...(ambient ? {} : { fetch: nodeFetch }), transport: "sse" });
 };
 return { models, streamFn };
}
