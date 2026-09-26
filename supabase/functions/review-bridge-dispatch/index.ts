// Delivery-only bridge. Never treat a queue insert as permission to review or merge.
// Test-only and real review records dispatch to distinct permanent workflow paths.
const EVENT_TYPE = "autonomous_review_inserted";
const TEST_EVENT_TYPE = "autonomous_review_test_inserted";
const DISPATCH_URL =
  "https://api.github.com/repos/AlexBDevCorner/AutonomousWork/dispatches";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Compare fixed-length digests instead of comparing secrets with a variable-time
// string equality. Do not print either secret, incoming headers or full payloads.
async function sameSecret(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = provided.length === 0 ? 1 : 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function validInsert(body: unknown): body is {
  type: "INSERT";
  table: "autonomous_review_queue";
  schema: "public";
  record: { id: string; test_only: boolean };
  old_record: null;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const event = body as Record<string, unknown>;
  if (event.type !== "INSERT" ||
      event.table !== "autonomous_review_queue" ||
      event.schema !== "public" ||
      event.old_record !== null) return false;
  const record = event.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const row = record as Record<string, unknown>;
  return typeof row.id === "string" && UUID.test(row.id) &&
    row.schema_version === 1 &&
    row.source === "chatgpt-scheduled" &&
    row.status === "queued" &&
    typeof row.test_only === "boolean" &&
    typeof row.repository === "string" &&
    /^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(row.repository) &&
    typeof row.project_id === "string" && /^[a-z0-9-]+$/.test(row.project_id) &&
    typeof row.task_id === "string" && /^[A-Z][A-Z0-9]*-[0-9]+$/.test(row.task_id) &&
    Number.isSafeInteger(row.pr_number) && (row.pr_number as number) > 0 &&
    typeof row.reviewed_sha === "string" && SHA.test(row.reviewed_sha) &&
    ["APPROVE", "REQUEST_CHANGES", "WITHHOLD", "MERGE_CHECK"].includes(String(row.verdict)) &&
    Array.isArray(row.findings) &&
    row.ci !== null && typeof row.ci === "object" && !Array.isArray(row.ci) &&
    typeof row.observed_at === "string" && !Number.isNaN(Date.parse(row.observed_at));
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json(405, { error: "POST required" });

  const expected = Deno.env.get("REVIEW_BRIDGE_WEBHOOK_SECRET");
  const dispatchToken = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!expected || !dispatchToken) {
    console.error("review bridge: required Edge Function secrets are not provisioned");
    return json(503, { error: "bridge not configured" });
  }
  const supplied = request.headers.get("x-review-bridge-secret") ?? "";
  if (!(await sameSecret(supplied, expected))) return json(401, { error: "unauthorized" });

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 65536) return json(413, { error: "payload too large" });
  let payload: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json(413, { error: "payload too large" });
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (!validInsert(payload)) return json(422, { error: "invalid queue insert event" });

  // No row content, verdict, repository or credentials leave Supabase.
  // The workflow MUST fetch the row independently and never trust the event.
  const queueId = payload.record.id;
  let response: Response;
  try {
    response = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dispatchToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: payload.record.test_only ? TEST_EVENT_TYPE : EVENT_TYPE,
        client_payload: { queue_id: queueId },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    console.error("review bridge: GitHub dispatch transport failure", queueId);
    return json(502, { error: "dispatch transport error", queue_id: queueId });
  }
  if (response.status !== 204) {
    // GitHub's error body can contain request data. Log only the status and ID.
    console.error("review bridge: GitHub dispatch rejected", queueId, response.status);
    return json(502, { error: "dispatch rejected", github_status: response.status, queue_id: queueId });
  }
  console.info("review bridge: dispatched", queueId);
  return json(202, { dispatched: true, queue_id: queueId });
});
