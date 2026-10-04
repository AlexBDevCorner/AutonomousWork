import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueApi } from './processor.mjs';
import { recoverRows } from './recovery.mjs';

const token = 'x'.repeat(32);
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

test('QueueApi recoverable lists only validated live queue ids', async () => {
  let seen;
  const fetcher = async url => {
    seen = new URL(url);
    return new Response(JSON.stringify({ ids }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const queue = new QueueApi(token, fetcher, 'live');
  assert.deepEqual(await queue.recoverable(10), ids);
  assert.equal(seen.searchParams.get('mode'), 'live');
  assert.equal(seen.searchParams.get('action'), 'recoverable');
  assert.equal(seen.searchParams.get('limit'), '10');
});

test('QueueApi recoverable fails closed on malformed or duplicate ids', async () => {
  const fetcher = async () => new Response(JSON.stringify({ ids: [ids[0], ids[0]] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const queue = new QueueApi(token, fetcher, 'live');
  await assert.rejects(() => queue.recoverable(), /Malformed recovery queue response/);
});

test('recoverRows continues after one row fails', async () => {
  const queue = { recoverable: async () => ids };
  const seen = [];
  const outcomes = await recoverRows({
    queue,
    processRow: async id => {
      seen.push(id);
      if (id === ids[0]) throw new Error('temporary failure');
      return { outcome: 'processed', status: 'applied', reason: 'merge_confirmed' };
    },
  });
  assert.deepEqual(seen, ids);
  assert.equal(outcomes[0].outcome, 'error');
  assert.equal(outcomes[1].outcome, 'processed');
});
