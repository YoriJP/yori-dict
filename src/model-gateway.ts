import { OpenRouter } from "@openrouter/sdk";
import {
  ModelGatewayError,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse
} from "./on-demand-dictionary";

type OpenRouterClient = {
  chat: {
    send(request: any, options?: any): Promise<any>;
  };
};

export function createOpenRouterModelGateway(options: {
  apiKey?: string;
  client?: OpenRouterClient;
}): ModelGateway {
  const client = options.client ?? (options.apiKey
    ? new OpenRouter({
        apiKey: options.apiKey,
        appTitle: "Yori Dictionary",
        retryConfig: { strategy: "none" }
      })
    : null);

  return {
    async call(input) {
      if (!client) throw new ModelGatewayError("configuration", "OPENROUTER_API_KEY is not configured");
      try {
        const result = await client.chat.send({
          xOpenRouterMetadata: "enabled",
          chatRequest: {
            model: input.model,
            messages: [{ role: "user", content: input.prompt }],
            reasoning: { effort: input.reasoningEffort },
            serviceTier: input.requestedServiceTier === "flex" ? "flex" : "default",
            provider: { allowFallbacks: false, requireParameters: true },
            ...(input.responseSchema ? {
              responseFormat: {
                type: "json_schema" as const,
                jsonSchema: {
                  name: input.responseSchema.name,
                  strict: true,
                  schema: input.responseSchema.schema
                }
              }
            } : {}),
            stream: false
          }
        }, {
          signal: input.signal,
          retries: { strategy: "none" }
        });
        return parseResponse(result);
      } catch (error) {
        if (error instanceof ModelGatewayError) throw error;
        throw new ModelGatewayError(classifyError(error), errorMessage(error));
      }
    }
  };
}

function parseResponse(result: any): ModelResponse {
  const content = result?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("")
      : "";
  if (typeof result?.id !== "string" || !result.id) {
    throw new ModelGatewayError("permanent", "OpenRouter response omitted its request id");
  }
  const attempts = result.openrouterMetadata?.attempts;
  const provider = Array.isArray(attempts) && attempts.length > 0
    ? String(attempts[attempts.length - 1]?.provider ?? "OpenRouter")
    : "OpenRouter";
  return {
    text,
    requestId: result.id,
    model: typeof result.model === "string" ? result.model : "unknown",
    provider,
    effectiveServiceTier: result.serviceTier === "flex" ? "flex" : "standard",
    inputTokens: result.usage?.promptTokens ?? 0,
    outputTokens: result.usage?.completionTokens ?? 0
  };
}

function classifyError(error: unknown): ModelGatewayError["kind"] {
  const status = typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode: unknown }).statusCode)
    : undefined;
  const message = errorMessage(error);
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) return "transient";
  if (status === 401 || status === 403) return "authentication";
  if (status === 400 && /unsupported|unknown parameter|service.?tier/i.test(message)) return "unsupported-parameter";
  if (error instanceof Error && /ConnectionError|RequestTimeoutError|RequestAbortedError/.test(error.name)) return "transient";
  return "permanent";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const body = typeof error === "object" && "body" in error ? String((error as { body: unknown }).body) : "";
    return body ? `${error.message}: ${body}`.slice(0, 500) : error.message;
  }
  return "OpenRouter request failed";
}
