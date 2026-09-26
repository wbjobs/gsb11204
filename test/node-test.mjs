// Node 集成测试：shim 浏览器 API，驱动真实的 worker.js / configCenter.js
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录（本文件位于 test/ 下）
const B = resolve(fileURLToPath(import.meta.url), '..', '..');

// ---------- IndexedDB 内存 shim ----------
const databases = new Map();

class FakeRequest {
  constructor() { this.onsuccess = null; this.onerror = null; }
  _succeed(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
  }
}

class FakeObjectStore {
  constructor(tx, name) { this.tx = tx; this.name = name; }
  _map() { return this.tx.db._data.stores.get(this.name); }
  put(value) {
    const map = this._map();
    const cloned = structuredClone(value);
    if (cloned[map.keyPath] === undefined && map.autoIncrement) cloned[map.keyPath] = ++map._seq;
    map.set(cloned[map.keyPath], cloned);
    const req = new FakeRequest(); req._succeed(undefined); return req;
  }
  get(key) {
    const req = new FakeRequest();
    req._succeed(structuredClone(this._map().get(key)));
    return req;
  }
  getAll() {
    const req = new FakeRequest();
    req._succeed([...this._map().values()].map((v) => structuredClone(v)));
    return req;
  }
  index(name) {
    const store = this;
    return {
      getAll(key) {
        const req = new FakeRequest();
        const idx = store.tx.db._data.indexes.get(store.name + ':' + name);
        req._succeed([...store._map().values()].filter((v) => v[idx] === key).map((v) => structuredClone(v)));
        return req;
      },
    };
  }
}

class FakeTransaction {
  constructor(db, storeNames) {
    this.db = db;
    this.storeNames = [].concat(storeNames);
    this.oncomplete = null; this.onerror = null; this.onabort = null;
    setTimeout(() => queueMicrotask(() => this.oncomplete && this.oncomplete()));
  }
  objectStore(name) { return new FakeObjectStore(this, name); }
}

class FakeDB {
  constructor(name, data) { this.name = name; this._data = data; }
  get objectStoreNames() { return { contains: (n) => this._data.stores.has(n) }; }
  createObjectStore(name, opts) {
    const map = new Map();
    map.keyPath = opts.keyPath;
    map.autoIncrement = !!opts.autoIncrement;
    map._seq = 0;
    this._data.stores.set(name, map);
    return {
      createIndex: (idxName, keyPath) => this._data.indexes.set(name + ':' + idxName, keyPath),
    };
  }
  transaction(storeNames, mode) { return new FakeTransaction(this, storeNames); }
}

globalThis.indexedDB = {
  open(name, version) {
    const req = new FakeRequest();
    queueMicrotask(() => {
      let data = databases.get(name);
      const isNew = !data;
      if (isNew) { data = { stores: new Map(), indexes: new Map() }; databases.set(name, data); }
      const db = new FakeDB(name, data);
      req.result = db;
      if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
      queueMicrotask(() => req.onsuccess && req.onsuccess({ target: req }));
    });
    return req;
  },
  deleteDatabase(name) {
    const req = new FakeRequest();
    databases.delete(name);
    req._succeed(undefined);
    return req;
  },
};

// ---------- localStorage shim ----------
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};

// ---------- Worker shim：data: URL 注入独立 self，模拟真实 Worker 的独立全局 ----------
import { readFileSync } from 'node:fs';
let workerSeq = 0;
globalThis.__workerRegistry = {};
class FakeWorker {
  constructor(url) {
    const id = ++workerSeq;
    const selfObj = {
      postMessage: (msg) => queueMicrotask(() => this.onmessage && this.onmessage({ data: msg })),
    };
    globalThis.__workerRegistry[id] = selfObj;
    let src = readFileSync(resolve(B, url), 'utf8');
    src = src.replaceAll("from './", `from '${pathToFileURL(resolve(B, 'js')).href}/`);
    src = `const self = globalThis.__workerRegistry[${id}];\n` + src;
    this.ready = import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
    this._self = selfObj;
  }
  postMessage(msg) { this.ready.then(() => this._self.onmessage({ data: msg })); }
  terminate() {}
}
globalThis.Worker = FakeWorker;

// ---------- 加载被测代码 ----------
const { ConfigCenter } = await import(pathToFileURL(resolve(B, 'js/configCenter.js')).href);
const { getPath } = await import(pathToFileURL(resolve(B, 'js/merge.js')).href);

// ---------- 测试框架 ----------
let passed = 0, failed = 0;
function report(name, ok, detail = '') {
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? passed++ : failed++;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function waitFor(fn, timeout = 3000, interval = 30) {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - start > timeout) return rej(new Error('等待超时'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

const TEST_DB = 'config-center-test';
await new Promise((r) => { const q = indexedDB.deleteDatabase(TEST_DB); q.onsuccess = q.onerror = r; });

// 1. 继承链正确
{
  const c = new ConfigCenter({ dbName: TEST_DB });
  await c.init();
  await c.switchTenant('tenant-1');
  const eff = c.effective;
  try {
    assert(getPath(eff.config, 'ui.theme') === 'dark', 'ui.theme 应来自 group-a');
    assert(getPath(eff.config, 'ui.language') === 'en-US', 'ui.language 应来自 tenant-1');
    assert(getPath(eff.config, 'ui.pageSize') === 20, 'ui.pageSize 应来自 global');
    assert(getPath(eff.config, 'limits.apiRateLimit') === 500, 'apiRateLimit 应来自 tenant-1');
    assert(getPath(eff.config, 'limits.maxUploadMB') === 10, 'maxUploadMB 应来自 global');
    assert(getPath(eff.config, 'feature.newDashboard') === true, 'newDashboard 应来自 group-a');
    assert(eff.provenance['ui.theme'] === 'group-a', 'provenance ui.theme');
    assert(eff.provenance['ui.language'] === 'tenant-1', 'provenance ui.language');
    assert(eff.provenance['ui.pageSize'] === 'global', 'provenance ui.pageSize');
    assert(eff.chain.map((l) => l.tenantId).join('>') === 'global>group-a>tenant-1', '继承链顺序');
    report('继承链正确（global → group-a → tenant-1，就近覆盖）', true);
  } catch (e) { report('继承链正确', false, e.message); }
  c.destroy();
}

// 2. 租户覆盖生效
{
  const c = new ConfigCenter({ dbName: TEST_DB });
  await c.init();
  await c.switchTenant('tenant-2');
  try {
    assert(getPath(c.effective.config, 'ui.theme') === 'dark', '覆盖前应为 group-a 的 dark');
    const r = await c.setEntry('ui.theme', 'blue');
    assert(!r.conflict, '写入不应冲突');
    assert(getPath(c.effective.config, 'ui.theme') === 'blue', '覆盖后应为 blue');
    assert(c.effective.provenance['ui.theme'] === 'tenant-2', '来源应为 tenant-2');
    report('租户覆盖生效', true);
  } catch (e) { report('租户覆盖生效', false, e.message); }
  c.destroy();
}

// 3. 热更新即时
{
  const a = new ConfigCenter({ dbName: TEST_DB });
  const b = new ConfigCenter({ dbName: TEST_DB });
  await a.init(); await b.init();
  await a.switchTenant('tenant-3');
  await b.switchTenant('tenant-3');
  let bUpdated = null;
  b.on('change', (eff) => { bUpdated = eff; });
  try {
    await a.setEntry('hot.key', 'hot-value-' + Date.now());
    await waitFor(() => bUpdated && getPath(bUpdated.config, 'hot.key'));
    assert(getPath(bUpdated.config, 'hot.key').startsWith('hot-value'), 'B 应收到 A 的写入');
    report('热更新即时（BroadcastChannel 跨实例推送）', true);
  } catch (e) { report('热更新即时', false, e.message); }
  a.destroy(); b.destroy();
}

// 4. 回滚正确
{
  const c = new ConfigCenter({ dbName: TEST_DB });
  await c.init();
  await c.switchTenant('tenant-2');
  try {
    const before = await c.getHistory();
    const target = before[before.length - 1].version;
    await c.setEntry('rollback.test', 'will-be-removed');
    assert(getPath(c.effective.config, 'rollback.test') === 'will-be-removed', '写入后应存在');
    await c.rollback(target);
    assert(getPath(c.effective.config, 'rollback.test') === undefined, '回滚后应消失');
    assert(getPath(c.effective.config, 'ui.theme') === 'dark', '回滚后应恢复继承值');
    const after = await c.getHistory();
    assert(after[0].op === 'rollback', '回滚应生成新版本记录');
    report(`回滚正确（回到 v${target}，生成新版本 v${after[0].version}）`, true);
  } catch (e) { report('回滚正确', false, e.message); }
  c.destroy();
}

// 5. 冲突可检测
{
  const c = new ConfigCenter({ dbName: TEST_DB });
  await c.init();
  await c.switchTenant('tenant-3');
  try {
    const stale = c.effective.version;
    await c.setEntry('conflict.a', 1);
    const r = await c.setEntry('conflict.b', 2, stale);
    assert(r.conflict === true, '过期写入应返回 conflict');
    assert(r.currentVersion === stale + 1, '应返回当前版本号');
    assert(getPath(c.effective.config, 'conflict.b') === undefined, '冲突写入不应生效');
    report('冲突可检测（乐观锁 baseVersion 校验）', true);
  } catch (e) { report('冲突可检测', false, e.message); }
  c.destroy();
}

// 6. 租户切换不串数据
{
  const c = new ConfigCenter({ dbName: TEST_DB });
  await c.init();
  await c.switchTenant('tenant-1');
  try {
    await c.setEntry('private.t1', 'only-t1');
    await c.switchTenant('tenant-2');
    assert(getPath(c.effective.config, 'private.t1') === undefined, 'tenant-2 不应看到 tenant-1 私有配置');
    assert(getPath(c.effective.config, 'hot.key') === undefined, 'tenant-2 不应看到 tenant-3 配置');
    await c.switchTenant('tenant-1');
    assert(getPath(c.effective.config, 'private.t1') === 'only-t1', '切回 tenant-1 应恢复其数据');
    report('租户切换不串数据', true);
  } catch (e) { report('租户切换不串数据', false, e.message); }
  c.destroy();
}

// 7. 刷新不丢配置
{
  const c1 = new ConfigCenter({ dbName: TEST_DB });
  await c1.init();
  await c1.switchTenant('tenant-1');
  await c1.setEntry('persist.key', 'persist-value');
  const v1 = c1.effective.version;
  c1.destroy();
  const c2 = new ConfigCenter({ dbName: TEST_DB });
  await c2.init();
  try {
    assert(c2.currentTenant === 'tenant-1', '刷新后应记住当前租户');
    assert(getPath(c2.effective.config, 'persist.key') === 'persist-value', '刷新后配置应保留');
    assert(c2.effective.version === v1, '版本号应一致');
    const history = await c2.getHistory();
    assert(history.length > 1, '历史版本应保留');
    report('刷新不丢配置（IndexedDB 持久化）', true);
  } catch (e) { report('刷新不丢配置', false, e.message); }
  c2.destroy();
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
