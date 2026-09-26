// Web Worker：负责持久化（IndexedDB）、继承链合并、版本快照、冲突检测
import { openDB, dbGet, dbGetAll, dbGetAllByIndex, dbTransaction, reqToPromise, DEFAULT_DB_NAME } from './db.js';
import { mergeChain, setPath, deletePath } from './merge.js';

let db = null;
let channel = null;
let clientId = null;

const SEED_TENANTS = [
  { tenantId: 'global', name: '全局默认', parentId: null },
  { tenantId: 'group-a', name: '业务组 A', parentId: 'global' },
  { tenantId: 'group-b', name: '业务组 B', parentId: 'global' },
  { tenantId: 'tenant-1', name: '租户 1', parentId: 'group-a' },
  { tenantId: 'tenant-2', name: '租户 2', parentId: 'group-a' },
  { tenantId: 'tenant-3', name: '租户 3', parentId: 'group-b' },
];

const SEED_CONFIGS = {
  global: {
    data: {
      ui: { theme: 'light', language: 'zh-CN', pageSize: 20 },
      feature: { newDashboard: false, betaSearch: false },
      limits: { maxUploadMB: 10, apiRateLimit: 100 },
    },
  },
  'group-a': {
    data: {
      ui: { theme: 'dark' },
      feature: { newDashboard: true },
    },
  },
  'group-b': {
    data: {
      limits: { maxUploadMB: 50 },
    },
  },
  'tenant-1': {
    data: {
      ui: { language: 'en-US' },
      limits: { apiRateLimit: 500 },
    },
  },
  'tenant-2': { data: {} },
  'tenant-3': {
    data: {
      feature: { betaSearch: true },
    },
  },
};

async function seedIfEmpty() {
  const existing = await dbGetAll(db, 'tenants');
  if (existing.length > 0) return false;
  await dbTransaction(db, ['tenants', 'configs', 'versions'], async (t) => {
    const tenants = t.objectStore('tenants');
    const configs = t.objectStore('configs');
    const versions = t.objectStore('versions');
    for (const tenant of SEED_TENANTS) {
      tenants.put(tenant);
      const seed = SEED_CONFIGS[tenant.tenantId] || { data: {} };
      const doc = { tenantId: tenant.tenantId, data: seed.data, version: 1, updatedAt: Date.now() };
      configs.put(doc);
      versions.put({
        tenantId: tenant.tenantId,
        version: 1,
        data: seed.data,
        op: 'seed',
        note: '初始数据',
        timestamp: Date.now(),
      });
    }
  });
  return true;
}

// 继承链：从根到当前租户，带环检测
async function buildChain(tenantId) {
  const tenants = await dbGetAll(db, 'tenants');
  const byId = new Map(tenants.map((t) => [t.tenantId, t]));
  if (!byId.has(tenantId)) throw new Error(`租户不存在: ${tenantId}`);
  const chain = [];
  const seen = new Set();
  let cur = byId.get(tenantId);
  while (cur) {
    if (seen.has(cur.tenantId)) throw new Error(`继承链存在环: ${cur.tenantId}`);
    seen.add(cur.tenantId);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  const levels = [];
  for (const tenant of chain) {
    const doc = await dbGet(db, 'configs', tenant.tenantId);
    levels.push({
      tenantId: tenant.tenantId,
      name: tenant.name,
      data: doc ? doc.data : {},
      version: doc ? doc.version : 0,
    });
  }
  return levels;
}

async function getEffective(tenantId) {
  const levels = await buildChain(tenantId);
  const { config, provenance } = mergeChain(levels);
  return {
    tenantId,
    config,
    provenance,
    chain: levels.map((l) => ({ tenantId: l.tenantId, name: l.name, version: l.version, data: l.data })),
    version: levels.length ? levels[levels.length - 1].version : 0,
  };
}

// 写入：乐观锁冲突检测（baseVersion 必须等于当前版本）
async function mutate(tenantId, op, fn, baseVersion, note) {
  const result = await dbTransaction(db, ['configs', 'versions'], async (t) => {
    const configs = t.objectStore('configs');
    const versions = t.objectStore('versions');
    const doc = await reqToPromise(configs.get(tenantId));
    if (!doc) throw new Error(`租户不存在: ${tenantId}`);
    if (baseVersion !== undefined && baseVersion !== doc.version) {
      return {
        conflict: true,
        currentVersion: doc.version,
        currentData: doc.data,
      };
    }
    const nextData = fn(doc.data);
    const nextVersion = doc.version + 1;
    const next = { ...doc, data: nextData, version: nextVersion, updatedAt: Date.now() };
    configs.put(next);
    versions.put({
      tenantId,
      version: nextVersion,
      data: nextData,
      op,
      note: note || '',
      timestamp: Date.now(),
    });
    return { conflict: false, version: nextVersion };
  });
  if (!result.conflict) {
    notify(tenantId, result.version, op);
  }
  return result;
}

function notify(tenantId, version, op) {
  if (channel) {
    channel.postMessage({ kind: 'config-changed', tenantId, version, op, at: Date.now(), source: clientId });
  }
}

async function getHistory(tenantId) {
  const list = await dbGetAllByIndex(db, 'versions', 'byTenant', tenantId);
  return list.sort((a, b) => b.version - a.version);
}

async function rollback(tenantId, targetVersion) {
  const history = await getHistory(tenantId);
  const snapshot = history.find((h) => h.version === targetVersion);
  if (!snapshot) throw new Error(`版本不存在: ${tenantId}@${targetVersion}`);
  const result = await dbTransaction(db, ['configs', 'versions'], async (t) => {
    const configs = t.objectStore('configs');
    const versions = t.objectStore('versions');
    const doc = await reqToPromise(configs.get(tenantId));
    if (!doc) throw new Error(`租户不存在: ${tenantId}`);
    const nextVersion = doc.version + 1;
    const next = { ...doc, data: snapshot.data, version: nextVersion, updatedAt: Date.now() };
    configs.put(next);
    versions.put({
      tenantId,
      version: nextVersion,
      data: snapshot.data,
      op: 'rollback',
      note: `回滚到 v${targetVersion}`,
      timestamp: Date.now(),
    });
    return { version: nextVersion };
  });
  notify(tenantId, result.version, 'rollback');
  return result;
}

const handlers = {
  async init({ dbName, clientId: cid }) {
    clientId = cid;
    db = await openDB(dbName || DEFAULT_DB_NAME);
    channel = new BroadcastChannel('config-center:' + (dbName || DEFAULT_DB_NAME));
    const seeded = await seedIfEmpty();
    return { seeded };
  },
  async listTenants() {
    return dbGetAll(db, 'tenants');
  },
  async getEffective({ tenantId }) {
    return getEffective(tenantId);
  },
  async setEntry({ tenantId, path, value, baseVersion }) {
    return mutate(tenantId, 'set', (data) => setPath(data, path, value), baseVersion, `设置 ${path}`);
  },
  async deleteEntry({ tenantId, path, baseVersion }) {
    return mutate(tenantId, 'delete', (data) => deletePath(data, path), baseVersion, `删除 ${path}`);
  },
  async getHistory({ tenantId }) {
    return getHistory(tenantId);
  },
  async rollback({ tenantId, version }) {
    return rollback(tenantId, version);
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    const result = await handlers[type](payload || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
