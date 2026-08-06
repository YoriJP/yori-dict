import { expect, test } from "bun:test";
import { createOpenRouterModelGateway } from "../src/model-gateway";
import { ModelGatewayError, type ModelRequest } from "../src/on-demand-dictionary";

test("the OpenRouter adapter sends Flex requests with strict routing and no SDK retries", async () => {
  const calls: Array<{ request: any; options: any }> = [];
  const gateway = createOpenRouterModelGateway({
    client: {
      chat: {
        async send(request: any, options: any) {
          calls.push({ request, options });
          return {
            id: "gen-123",
            model: "openai/gpt-5.6-luna",
            object: "chat.completion",
            created: 1,
            systemFingerprint: null,
            serviceTier: "flex",
            choices: [{ index: 0, finishReason: "stop", message: { role: "assistant", content: "SKIP" } }],
            usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 },
            openrouterMetadata: {
              attempt: 0,
              attempts: [{ model: "openai/gpt-5.6-luna", provider: "OpenAI", status: 200 }]
            }
          };
        }
      }
    }
  });

  const response = await gateway.call(modelRequest("eligibility", "openai/gpt-5.6-luna", "flex"));

  expect(calls).toHaveLength(1);
  expect(calls[0].request.chatRequest).toEqual({
    model: "openai/gpt-5.6-luna",
    messages: [{ role: "user", content: "test prompt" }],
    reasoning: { effort: "minimal" },
    serviceTier: "flex",
    provider: { allowFallbacks: false, requireParameters: true },
    stream: false
  });
  expect(calls[0].options).toMatchObject({ retries: { strategy: "none" } });
  expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
  expect(response).toEqual({
    text: "SKIP",
    requestId: "gen-123",
    model: "openai/gpt-5.6-luna",
    provider: "OpenAI",
    effectiveServiceTier: "flex",
    inputTokens: 12,
    outputTokens: 2
  });
});

test("the OpenRouter adapter forwards the domain JSON schema for structured calls", async () => {
  let request: any;
  const gateway = createOpenRouterModelGateway({
    client: {
      chat: {
        async send(input: any) {
          request = input;
          return completion('{"candidateId":"x","issues":[]}');
        }
      }
    }
  });

  await gateway.call({
    ...modelRequest("entry-review", "google/gemini-3-flash-preview", "standard"),
    responseSchema: {
      name: "entry_review",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { candidateId: { type: "string" }, issues: { type: "array", items: { type: "string" } } },
        required: ["candidateId", "issues"]
      }
    }
  });

  expect(request.chatRequest.serviceTier).toBe("default");
  expect(request.chatRequest.responseFormat).toEqual({
    type: "json_schema",
    jsonSchema: {
      name: "entry_review",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { candidateId: { type: "string" }, issues: { type: "array", items: { type: "string" } } },
        required: ["candidateId", "issues"]
      }
    }
  });
});

test("the gateway classifies retryable, authentication, and unsupported failures", async () => {
  for (const [error, kind] of [
    [Object.assign(new Error("overloaded"), { statusCode: 503 }), "transient"],
    [Object.assign(new Error("bad key"), { statusCode: 401 }), "authentication"],
    [Object.assign(new Error("service tier unsupported"), { statusCode: 400, body: "unsupported service_tier" }), "unsupported-parameter"],
    [Object.assign(new Error("bad request"), { statusCode: 400 }), "permanent"]
  ] as const) {
    const gateway = createOpenRouterModelGateway({
      client: { chat: { async send() { throw error; } } }
    });
    await expect(gateway.call(modelRequest("eligibility", "openai/gpt-5.6-luna", "flex")))
      .rejects.toMatchObject({ name: "ModelGatewayError", kind });
  }
});

test("the gateway reports missing OpenRouter configuration without making a request", async () => {
  const gateway = createOpenRouterModelGateway({});
  await expect(gateway.call(modelRequest("eligibility", "openai/gpt-5.6-luna", "flex")))
    .rejects.toEqual(new ModelGatewayError("configuration", "OPENROUTER_API_KEY is not configured"));
});

function modelRequest(
  role: ModelRequest["role"],
  model: string,
  requestedServiceTier: ModelRequest["requestedServiceTier"]
): ModelRequest {
  return {
    role,
    provider: "openrouter",
    requestedServiceTier,
    prompt: "test prompt",
    promptVersion: "test-v1",
    model,
    reasoningEffort: "minimal",
    signal: new AbortController().signal
  };
}

function completion(text: string): any {
  return {
    id: "gen-456",
    model: "google/gemini-3-flash-preview",
    object: "chat.completion",
    created: 1,
    systemFingerprint: null,
    choices: [{ index: 0, finishReason: "stop", message: { role: "assistant", content: text } }],
    usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 }
  };
}
