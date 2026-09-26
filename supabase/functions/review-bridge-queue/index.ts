// Queue-scoped HTTP API for the trusted default-branch workflow only.
// GitHub receives a random queue-only token, NEVER a Supabase service-role key.
// Database RPCs isolate test queue rows from real review processing.
const QUEUE = "autonomous_review_queue";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINISH = new Set(["dry_run", "stale", "withheld", "failed", "retryable"]);
const LIVE_FINISH = new Set(["applied", "stale", "withheld", "failed", "retryable"]);
// Real queue rows require an explicit live mode and server-side claim fencing.
const API = "https://ayewunekctfmdxgjtqfl.supabase.co/rest/v1/";

const response = (status: number, data: Record<string, unknown>) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function sameSecret(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = provided.length === 0 ? 1 : 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function postgres(path: string, dbKey: string, body?: object): Promise<Response> {
  return fetch(new URL(path, API), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      apikey: dbKey, // A named sb_secret_ key belongs ONLY to this server-side function.
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
}

function expectedPayload(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

Deno.serve(async (request: Request): Promise<Response> => {
  const workerSecret = Deno.env.get("REVIEW_BRIDGE_QUEUE_TOKEN");
  const dbKey = Deno.env.get("REVIEW_BRIDGE_DB_KEY");
  if (!workerSecret || workerSecret.length < 32 || !dbKey?.startsWith("sb_secret_")) {
    console.error("queue API not configured");
    return response(503, { error: "queue API not configured" });
  }
  if (!(await sameSecret(request.headers.get("x-review-bridge-queue-token") ?? "", workerSecret))) {
    return response(401, { error: "unauthorized" });
  }
  let result: Response;
  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      const live = url.searchParams.get("mode") === "live";
      if (!id || !UUID.test(id) || (url.searchParams.has("mode") && !live) ||
          [...url.searchParams.keys()].some((k) => !["id", "mode"].includes(k))) {
        return response(422, { error: "invalid queue UUID" });
      }
      const q = new URLSearchParams({
        select: "id,schema_version,source,repository,project_id,task_id,pr_number,reviewed_sha,verdict,findings,ci,review_summary,observed_at,test_only,status,attempts,claimed_at,lease_until,github_review_id,merge_sha",
        id: "eq." + id,
        test_only: live ? "eq.false" : "eq.true",
        ...(live ? { source: "eq.chatgpt-scheduled" } : {}),
        limit: "1",
      });
      result = await postgres(QUEUE + "?" + q, dbKey);
      if (!result.ok) throw new Error("database read status " + result.status);
      const rows = await result.json();
      if (!Array.isArray(rows)) throw new Error("database returned non-array");
      if (rows.length !== 1) return response(404, { error: "queue row not found" });
      return response(200, { row: rows[0] });
    }

    if (request.method !== "POST") return response(405, { error: "unsupported method" });
    const bytes = await request.text();
    if (bytes.length > 6000) return response(413, { error: "request too large" });
    let value: unknown;
    try { value = JSON.parse(bytes); } catch { return response(400, { error: "invalid JSON" }); }
    if (!object(value) || typeof value.id !== "string" || !UUID.test(value.id)) {
      return response(422, { error: "invalid queue request" });
    }

    const live = value.mode === "live";
    if (value.mode !== undefined && !live) return response(422, { error: "invalid queue mode" });

    if (value.action === "claim" && expectedPayload(value, ["action", "id", "mode"])) {
      result = await postgres(live ? "rpc/review_bridge_claim_live_queue" :
        "rpc/review_bridge_claim_test_queue", dbKey, { p_id: value.id });
      if (!result.ok) throw new Error("database claim status " + result.status);
      const rows = await result.json();
      if (!Array.isArray(rows)) throw new Error("database returned non-array");
      if (rows.length > 1) throw new Error("unexpected multiple claims");
      return response(200, rows.length === 1 ? { claimed: true, row: rows[0] } : { claimed: false });
    }

    if (value.action === "finish" &&
        expectedPayload(value, ["action", "id", "mode", "claim_token", "status", "reason", "evidence", "review_id", "merge_sha"]) &&
        typeof value.claim_token === "string" && UUID.test(value.claim_token) &&
        typeof value.status === "string" && (live ? LIVE_FINISH : FINISH).has(value.status) &&
        (live || (value.review_id === undefined && value.merge_sha === undefined)) &&
        (value.review_id === undefined || value.review_id === null ||
          Number.isSafeInteger(value.review_id) && (value.review_id as number) > 0) &&
        (value.merge_sha === undefined || value.merge_sha === null ||
          typeof value.merge_sha === "string" && /^[a-f0-9]{40}$/.test(value.merge_sha)) &&
        (value.reason === null || typeof value.reason === "string" && value.reason.length <= 500) &&
        object(value.evidence) && JSON.stringify(value.evidence).length <= 4096) {
      result = await postgres(live ? "rpc/review_bridge_finish_live_queue" :
        "rpc/review_bridge_finish_test_queue", dbKey, {
        p_id: value.id,
        p_token: value.claim_token,
        p_status: value.status,
        p_reason: value.reason,
        p_evidence: value.evidence,
        ...(live ? { p_review_id: value.review_id ?? null, p_merge_sha: value.merge_sha ?? null } : {}),
      });
      if (!result.ok) throw new Error("database finish status " + result.status);
      const applied = await result.json();
      if (typeof applied !== "boolean") throw new Error("database returned invalid finish result");
      return response(applied ? 200 : 409, { finished: applied });
    }

    return response(422, { error: "invalid queue action or fields" });
  } catch (error) {
    // No response bodies, database credentials, record content, or authorization headers in logs.
    console.error("queue API internal request failed", error instanceof Error ? error.message : "unknown error");
    return response(502, { error: "queue API backend failure" });
  }
});
