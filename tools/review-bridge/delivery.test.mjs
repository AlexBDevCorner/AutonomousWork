import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpoint, isQueueId, validateDeliveryRow } from './delivery.mjs';

const id = '550e8400-e29b-41d4-a716-446655440000';
const row = {
  id, schema_version: 1, source: 'chatgpt-scheduled',
  repository: 'AlexBDevCorner/MtgSoloSports', project_id: 'mtg-solo-sports',
  task_id: 'MSS-001', pr_number: 3, reviewed_sha: 'a'.repeat(40),
  verdict: 'WITHHOLD', findings: [{ severity: 'P2', description: 'fixture' }],
  ci: { status: 'success' }, review_summary: 'Delivery fixture',
  observed_at: '2026-09-25T12:00:00Z', test_only: true, status: 'queued',
};

test('validates real-looking test rows', () => {
  assert.equal(validateDeliveryRow(row, id), null);
  assert.equal(validateDeliveryRow({ ...row, status: 'dry_run' }, id), null);
});
test('rejects non-test delivery, spoofed source and mismatched ID', () => {
  assert.match(validateDeliveryRow({ ...row, test_only: false }, id), /non-test/);
  assert.match(validateDeliveryRow({ ...row, source: 'unknown' }, id), /source/);
  assert.match(validateDeliveryRow(row, '550e8400-e29b-41d4-a716-446655440001'), /UUID/);
});
test('rejects malformed and unsupported rows', () => {
  for (const patch of [
    { reviewed_sha: 'not-a-sha' }, { status: 'applied' },
    { verdict: 'APPROVED' }, { findings: {} }, { ci: [] },
    { repository: 'another-owner/repo' }, { task_id: 'invalid' },
    { observed_at: 'not-a-date' },
  ]) {
    assert.notEqual(validateDeliveryRow({ ...row, ...patch }, id), null);
  }
});
test('requires UUID payload and conditional acknowledgement', () => {
  assert.equal(isQueueId(id), true);
  assert.equal(isQueueId('a'.repeat(40)), false);
  const get = endpoint('https://example.supabase.co', id);
  assert.equal(get.searchParams.get('id'), `eq.${id}`);
  const patch = endpoint('https://example.supabase.co', id, true);
  assert.equal(patch.searchParams.get('status'), 'eq.queued');
  assert.equal(patch.searchParams.get('test_only'), 'eq.true');
});
