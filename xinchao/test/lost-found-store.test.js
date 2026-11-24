import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LostFoundStore } from '../src/lost-found-store.js';

async function stores() {
  const dir = await mkdtemp(join(tmpdir(), 'xinchao-lost-found-'));
  const file = join(dir, 'items.json');
  return {
    dir,
    yanzhou: new LostFoundStore(file, 'yanzhou'),
    linzhao: new LostFoundStore(file, 'linzhao'),
  };
}

test('identity-targeted entries stay invisible to the other identity', async () => {
  const ctx = await stores();
  try {
    await ctx.yanzhou.deposit({ eventId: 'event-yanzhou-001', target: 'yanzhou', summary: '只属于砚舟的事实摘要' });
    assert.equal((await ctx.yanzhou.list()).items.length, 1);
    assert.equal((await ctx.linzhao.list()).items.length, 0);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});

test('unknown entries can only be claimed by one identity', async () => {
  const ctx = await stores();
  try {
    const saved = await ctx.yanzhou.deposit({ eventId: 'event-unknown-001', target: 'unknown', summary: '身份尚不确定的摘要' });
    await ctx.linzhao.resolve({ id: saved.item.id, action: 'claim' });
    assert.equal((await ctx.yanzhou.list()).items.length, 0);
    assert.equal((await ctx.linzhao.list({ includeResolved: true })).items[0].assignedTo, 'linzhao');
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});

test('shared entries can be independently resolved by both identities', async () => {
  const ctx = await stores();
  try {
    const saved = await ctx.yanzhou.deposit({ eventId: 'event-shared-001', target: 'shared', summary: '共同经历摘要' });
    await Promise.all([
      ctx.yanzhou.resolve({ id: saved.item.id, action: 'claim' }),
      ctx.linzhao.resolve({ id: saved.item.id, action: 'partial', acceptedSummary: '阿照接纳的共同部分' }),
    ]);
    const item = (await ctx.yanzhou.list({ includeResolved: true })).items[0];
    assert.equal(item.resolutions.yanzhou.action, 'claim');
    assert.equal(item.resolutions.linzhao.action, 'partial');
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});

test('event ids are idempotent across both instances', async () => {
  const ctx = await stores();
  try {
    const first = await ctx.yanzhou.deposit({ eventId: 'event-dedupe-001', target: 'shared', summary: '同一件事' });
    const second = await ctx.linzhao.deposit({ eventId: 'event-dedupe-001', target: 'shared', summary: '不应新增' });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal((await ctx.yanzhou.list()).items.length, 1);
  } finally { await rm(ctx.dir, { recursive: true, force: true }); }
});
