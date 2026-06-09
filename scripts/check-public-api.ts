type Check = {
  name: string;
  run: () => Promise<void>;
};

export {};

const baseUrl = (process.env.YORI_PUBLIC_API_URL ?? "https://yori-dict-production.up.railway.app").replace(/\/$/, "");

const checks: Check[] = [
  {
    name: "index",
    run: async () => {
      const body = await getJson<Record<string, unknown>>("/");
      assertEqual(body.name, "Yori Dict", "index name");
      assertEqual(body.docs, "/doc", "index docs link");
      assertEqual(body.openapi, "/openapi.yaml", "index OpenAPI link");
    }
  },
  {
    name: "health",
    run: async () => {
      const body = await getJson<{ ok?: unknown }>("/health");
      assertEqual(body.ok, true, "health ok");
    }
  },
  {
    name: "docs",
    run: async () => {
      const { response, text } = await getText("/doc");
      assertIncludes(response.headers.get("content-type") ?? "", "text/html", "docs content type");
      assertIncludes(text.toLowerCase(), "scalar", "docs page");
      assertIncludes(text, "/openapi.yaml", "docs OpenAPI URL");
    }
  },
  {
    name: "openapi",
    run: async () => {
      const { response, text } = await getText("/openapi.yaml");
      assertIncludes(response.headers.get("content-type") ?? "", "application/yaml", "OpenAPI content type");
      assertIncludes(text, "openapi: 3.1.0", "OpenAPI body");
    }
  },
  {
    name: "lookup",
    run: async () => {
      const body = await getJson<{ item?: { id?: unknown; senses?: unknown[] } }>(
        "/v1/lookup?q=%E9%A3%9F%E3%81%B9%E3%81%BE%E3%81%97%E3%81%9F&lang=zh-tw"
      );
      assertEqual(body.item?.id, "yori:e_jmdict_1358280", "lookup entry id");
      if (!Array.isArray(body.item?.senses) || body.item.senses.length === 0) {
        throw new Error("lookup returned no senses");
      }
    }
  },
  {
    name: "batch lookup",
    run: async () => {
      const response = await fetch(`${baseUrl}/v1/lookup/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: ["食べました", "学校", "存在しない語"], lang: "zh-tw" })
      });
      if (!response.ok) throw new Error(`batch lookup returned ${response.status}`);

      const body = (await response.json()) as { results?: unknown[] };
      if (!Array.isArray(body.results) || body.results.length !== 3) {
        throw new Error("batch lookup did not return three results");
      }
    }
  }
];

let failures = 0;

for (const check of checks) {
  const start = performance.now();
  try {
    await check.run();
    console.log(`ok\t${check.name}\t${(performance.now() - start).toFixed(0)}ms`);
  } catch (error) {
    failures += 1;
    console.error(`fail\t${check.name}\t${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`${failures} public API check(s) failed for ${baseUrl}`);
  process.exit(1);
}

console.log(`Public API checks passed for ${baseUrl}`);

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

async function getText(path: string): Promise<{ response: Response; text: string }> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return { response, text: await response.text() };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label}: expected to include ${JSON.stringify(expected)}`);
  }
}
