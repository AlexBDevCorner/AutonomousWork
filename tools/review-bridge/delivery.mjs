// Step 2 is connectivity-only. This script must never call GitHub's PR API.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'WITHHOLD', 'MERGE_CHECK']);

export function isQueueId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function validateDeliveryRow(row, queueId) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'invalid row';
  if (row.id !== queueId) return 'different UUID returned';
  if (row.schema_version !== 1) return 'unsupported schema';
  if (row.source !== 'chatgpt-scheduled') return 'unexpected source';
  if (row.test_only !== true) return 'non-test row blocked by Step 2';
  if (!['queued', 'dry_run'].includes(row.status)) return 'unexpected row status';
  if (typeof row.repository !== 'string' ||
      !/^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(row.repository)) return 'invalid repository';
  if (typeof row.project_id !== 'string' ||
      !/^[a-z0-9-]+$/.test(row.project_id)) return 'invalid project';
  if (typeof row.task_id !== 'string' ||
      !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(row.task_id)) return 'invalid task';
  if (!Number.isSafeInteger(row.pr_number) || row.pr_number <= 0) return 'invalid PR number';
  if (typeof row.reviewed_sha !== 'string' || !SHA.test(row.reviewed_sha)) return 'invalid reviewed SHA';
  if (!VERDICTS.has(row.verdict)) return 'invalid verdict';
  if (!Array.isArray(row.findings)) return 'invalid findings';
  if (!row.ci || typeof row.ci !== 'object' || Array.isArray(row.ci)) return 'invalid CI data';
  if (typeof row.review_summary !== 'string') return 'invalid summary';
  if (typeof row.observed_at !== 'string' || Number.isNaN(Date.parse(row.observed_at))) return 'invalid timestamp';
  return null;
}

export function endpoint(base, queueId, isPatch = false) {
  const url = new URL('/rest/v1/autonomous_review_queue', base);
  url.searchParams.set('id', `eq.${queueId}`);
  if (isPatch) {
    url.searchParams.set('status', 'eq.queued');
    url.searchParams.set('test_only', 'eq.true');
    url.searchParams.set('select', 'id,status,processed_at');
  } else {
    url.searchParams.set('select', 'id,schema_version,source,repository,project_id,task_id,pr_number,reviewed_sha,verdict,findings,ci,review_summary,observed_at,test_only,status');
  }
  return url;
}

function summary(message) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
  }
}

async function supabaseRequest(url, key, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Accept: 'application/json',
      ...(method === 'PATCH' ? { 'Content-Type': 'application/json', Prefer: 'return=representation' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // Do not print response bodies: they may contain sensitive records.
    throw new Error(`Supabase ${method} failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Supabase returned an unexpected result shape');
  return data;
}

export async function deliver({ queueId, base, key }) {
  if (!isQueueId(queueId)) throw new Error('Expected a UUID queue_id');
  if (!key || !base) throw new Error('SUPABASE_URL / SUPABASE_REVIEW_BRIDGE_KEY not configured');
  const rows = await supabaseRequest(endpoint(base, queueId), key, 'GET');
  if (rows.length !== 1) throw new Error('Exactly one matching Supabase queue row was expected');
  const row = rows[0];
  const invalid = validateDeliveryRow(row, queueId);
  if (invalid) throw new Error(`Queue row rejected: ${invalid}`);
  if (row.status === 'dry_run') return 'already_acknowledged';

  // Conditional PATCH prevents duplicate deliveries from re-acknowledging
  // a row. Guarded claim/lease handling is implemented in Step 3.
  const updated = await supabaseRequest(endpoint(base, queueId, true), key, 'PATCH', {
    status: 'dry_run',
    processed_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  if (updated.length === 0) return 'concurrent_or_stale';
  if (updated.length !== 1 || updated[0].id !== queueId || updated[0].status !== 'dry_run') {
    throw new Error('Unexpected acknowledgement result');
  }
  return 'acknowledged';
}

async function main() {
  const queueId = process.env.QUEUE_ID;
  const outcome = await deliver({
    queueId,
    base: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_REVIEW_BRIDGE_KEY,
  });
  console.info(`Review bridge: ${outcome}; queue_id=${queueId}`);
  summary(`### Review bridge delivery only\n\n- Queue ID: \`${queueId}\`\n- Result: **${outcome}**\n- No GitHub reviews or merges attempted.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
