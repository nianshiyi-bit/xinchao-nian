import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const IDENTITIES = new Set(['yanzhou', 'linzhao']);
const TARGETS = new Set(['yanzhou', 'linzhao', 'shared', 'unknown']);
const ACTIONS = new Set(['claim', 'partial', 'reject', 'defer']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function fresh() {
  return { schemaVersion: 1, revision: 0, items: [] };
}

export class LostFoundStore {
  constructor(filePath, identityId) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.identityId = clean(identityId, 40).toLowerCase();
    if (!IDENTITIES.has(this.identityId)) throw new Error('IDENTITY_ID 必须是 yanzhou 或 linzhao');
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try { await open(this.filePath, 'wx').then((handle) => handle.writeFile(JSON.stringify(fresh(), null, 2)).finally(() => handle.close())); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  async read() {
    await this.init();
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return parsed && Array.isArray(parsed.items) ? parsed : fresh();
    } catch (error) {
      if (error.code === 'ENOENT') return fresh();
      throw new Error(`失物招领处读取失败：${error.message}`);
    }
  }

  async withLock(fn) {
    await mkdir(dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await mkdir(this.lockPath);
        try { return await fn(); }
        finally { await rm(this.lockPath, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > 15_000) await rm(this.lockPath, { recursive: true, force: true });
        } catch { /* lock disappeared between checks */ }
        await sleep(25 + attempt * 2);
      }
    }
    throw new Error('失物招领处正忙，请稍后重试');
  }

  async update(mutator) {
    return this.withLock(async () => {
      const state = await this.read();
      const result = await mutator(state);
      state.revision = Number(state.revision ?? 0) + 1;
      state.items = state.items.slice(-500);
      const temp = join(dirname(this.filePath), `.lost-found-${process.pid}-${randomUUID()}.tmp`);
      await open(temp, 'wx').then((handle) => handle.writeFile(JSON.stringify(state, null, 2)).finally(() => handle.close()));
      await rename(temp, this.filePath);
      return { state, result };
    });
  }

  async deposit(input = {}, now = new Date()) {
    const eventId = clean(input.eventId, 120);
    const summary = clean(input.summary, 1600);
    const target = clean(input.target || 'unknown', 20).toLowerCase();
    if (eventId.length < 8) throw new Error('event_id 至少需要 8 个字符');
    if (!summary) throw new Error('summary 是必填项');
    if (!TARGETS.has(target)) throw new Error('target 必须是 yanzhou / linzhao / shared / unknown');
    const { state, result } = await this.update((current) => {
      const existing = current.items.find((item) => item.eventId === eventId);
      if (existing) return { item: existing, duplicate: true };
      const item = {
        id: `lf_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        eventId,
        target,
        summary,
        sourceWindow: clean(input.sourceWindow, 120) || null,
        occurredAt: clean(input.occurredAt, 40) || null,
        createdAt: now.toISOString(),
        depositedBy: this.identityId,
        assignedTo: target === 'yanzhou' || target === 'linzhao' ? target : null,
        resolutions: {},
      };
      current.items.push(item);
      return { item, duplicate: false };
    });
    return { ...result, revision: state.revision };
  }

  visibleTo(item) {
    if (item.target === this.identityId || item.target === 'shared') return true;
    if (item.target !== 'unknown') return false;
    return !item.assignedTo || item.assignedTo === this.identityId;
  }

  async list(input = {}) {
    const includeResolved = Boolean(input.includeResolved);
    const limit = Math.max(1, Math.min(100, Number(input.limit ?? 30)));
    const state = await this.read();
    const items = state.items.filter((item) => {
      if (!this.visibleTo(item)) return false;
      const resolution = item.resolutions?.[this.identityId];
      return includeResolved || !resolution || resolution.action === 'defer';
    }).slice(-limit).reverse();
    return { identityId: this.identityId, revision: state.revision, items };
  }

  async resolve(input = {}, now = new Date()) {
    const id = clean(input.id, 80);
    const action = clean(input.action, 20).toLowerCase();
    const acceptedSummary = clean(input.acceptedSummary, 1600);
    const note = clean(input.note, 500);
    if (!id) throw new Error('id 是必填项');
    if (!ACTIONS.has(action)) throw new Error('action 必须是 claim / partial / reject / defer');
    if (action === 'partial' && !acceptedSummary) throw new Error('partial 需要 accepted_summary');
    const { state, result } = await this.update((current) => {
      const item = current.items.find((candidate) => candidate.id === id);
      if (!item) return { found: false, id };
      if (!this.visibleTo(item)) throw new Error('这条不属于当前身份，不能认领');
      const previous = item.resolutions?.[this.identityId];
      if (previous && previous.action !== 'defer' && action !== 'defer') return { found: true, duplicate: true, item, resolution: previous };
      if (item.target === 'unknown' && ['claim', 'partial'].includes(action)) item.assignedTo = this.identityId;
      item.resolutions ??= {};
      item.resolutions[this.identityId] = {
        action,
        at: now.toISOString(),
        acceptedSummary: action === 'partial' ? acceptedSummary : (action === 'claim' ? item.summary : null),
        note: note || null,
      };
      return { found: true, duplicate: false, item, resolution: item.resolutions[this.identityId] };
    });
    return { ...result, identityId: this.identityId, revision: state.revision };
  }
}
