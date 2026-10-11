import {
  createProvider,
  envApiKeyAuth,
  openAICompletionsApi,
  type Provider,
} from "@earendil-works/pi-ai";

const KILO_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

export function kiloProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: "kilo",
    name: "Kilo Gateway",
    baseUrl: "https://api.kilo.ai/api/gateway",

    auth: {
      apiKey: envApiKeyAuth(
        "Kilo Gateway API key",
        ["KILO_GATEWAY_API_KEY"],
      ),
    },

    models: [
      {
        id: KILO_MODEL,
        name: "Nemotron 3 Ultra 550B A55B",
        api: "openai-completions",
        provider: "kilo",
        baseUrl: "https://api.kilo.ai/api/gateway",
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      },
    ],

    api: openAICompletionsApi(),
  });
}
