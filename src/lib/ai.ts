// Provider-agnostic AI layer: any OpenAI-compatible /chat/completions endpoint.
// Works with Gemini AI Studio (AIza… keys), GCP Vertex express (AQ.… keys),
// GLM / OpenAI / DeepSeek (sk-… keys) — the hackathon allows any AI tool.
//
// AQ.… (Vertex express) keys are auto-detected: Google rejects Authorization:
// Bearer for them, so we switch to the x-goog-api-key header and the
// google/<model> name prefix required by the Vertex OpenAI-compat endpoint.

const RAW_BASE = process.env.AI_BASE_URL ?? "";
const KEY = process.env.AI_API_KEY ?? "";
const RAW_MODEL = process.env.AI_MODEL ?? "";

const isVertexExpress = KEY.startsWith("AQ.");
const BASE = RAW_BASE.replace(/\/$/, "");
const MODEL = isVertexExpress && !RAW_MODEL.startsWith("google/") ? `google/${RAW_MODEL}` : RAW_MODEL;

export async function chat(system: string, user: string): Promise<string> {
  if (!BASE || !KEY || !MODEL) {
    throw new Error("AI env not configured (AI_BASE_URL / AI_API_KEY / AI_MODEL)");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isVertexExpress) headers["x-goog-api-key"] = KEY;
  else headers.Authorization = `Bearer ${KEY}`;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`AI call failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

/** Chat expecting a JSON object back; strips ```json fences. */
export async function chatJSON<T>(system: string, user: string): Promise<T> {
  const raw = await chat(
    system + "\nRespond with a single JSON object only. No prose, no code fences.",
    user,
  );
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned) as T;
}
