// 验收测试：独立测试库，不污染演示数据
import { ConfigCenter } from './configCenter.js';
import { getPath } from './merge.js';

const TEST_DB = 'config-center-test';
const results = document.getElementById('results');
let passed = 0;
let failed = 0;

function report(name, ok, detail = '') {
  const line = document.createElement('div');
  line.className = ok ? 'pass' : 'fail';
  line.textContent = `${ok ? '✓ PASS' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`;
  results.appendChild(line);
  ok ? passed++ : failed++;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function resetDB() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function waitFor(fn, timeout = 3000, interval = 30) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('等待超时'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function run() {
  results.textContent = '';
  await resetDB();

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
    } catch (e) {
      report('继承链正确', false, e.message);
    }
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
    } catch (e) {
      report('租户覆盖生效', false, e.message);
    }
    c.destroy();
  }

  // 3. 热更新即时（两个实例模拟两个标签页）
  {
    const a = new ConfigCenter({ dbName: TEST_DB });
    const b = new ConfigCenter({ dbName: TEST_DB });
    await a.init();
    await b.init();
    await a.switchTenant('tenant-3');
    await b.switchTenant('tenant-3');
    let bUpdated = null;
    b.on('change', (eff) => { bUpdated = eff; });
    try {
      await a.setEntry('hot.key', 'hot-value-' + Date.now());
      await waitFor(() => bUpdated && getPath(bUpdated.config, 'hot.key'));
      assert(getPath(bUpdated.config, 'hot.key').startsWith('hot-value'), 'B 应收到 A 的写入');
      report('热更新即时（BroadcastChannel 跨实例推送）', true);
    } catch (e) {
      report('热更新即时', false, e.message);
    }
    a.destroy();
    b.destroy();
  }

  // 4. 回滚正确
  {
    const c = new ConfigCenter({ dbName: TEST_DB });
    await c.init();
    await c.switchTenant('tenant-2');
    try {
      const before = await c.getHistory();
      const target = before[before.length - 1].version; // 最早版本（seed）
      await c.setEntry('rollback.test', 'will-be-removed');
      assert(getPath(c.effective.config, 'rollback.test') === 'will-be-removed', '写入后应存在');
      await c.rollback(target);
      assert(getPath(c.effective.config, 'rollback.test') === undefined, '回滚后应消失');
      assert(getPath(c.effective.config, 'ui.theme') === 'dark', '回滚后应恢复继承值');
      const after = await c.getHistory();
      assert(after[0].op === 'rollback', '回滚应生成新版本记录');
      report('回滚正确（回到 v' + target + '，生成新版本 v' + after[0].version + '）', true);
    } catch (e) {
      report('回滚正确', false, e.message);
    }
    c.destroy();
  }

  // 5. 冲突可检测
  {
    const c = new ConfigCenter({ dbName: TEST_DB });
    await c.init();
    await c.switchTenant('tenant-3');
    try {
      const stale = c.effective.version;
      await c.setEntry('conflict.a', 1); // 版本前进
      const r = await c.setEntry('conflict.b', 2, stale); // 用过期的 baseVersion
      assert(r.conflict === true, '过期写入应返回 conflict');
      assert(r.currentVersion === stale + 1, '应返回当前版本号');
      assert(getPath(c.effective.config, 'conflict.b') === undefined, '冲突写入不应生效');
      report('冲突可检测（乐观锁 baseVersion 校验）', true);
    } catch (e) {
      report('冲突可检测', false, e.message);
    }
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
      assert(getPath(c.effective.config, 'private.t1') === undefined, 'tenant-2 不应看到 tenant-1 的私有配置');
      assert(getPath(c.effective.config, 'hot.key') === undefined, 'tenant-2 不应看到 tenant-3 的配置');
      await c.switchTenant('tenant-1');
      assert(getPath(c.effective.config, 'private.t1') === 'only-t1', '切回 tenant-1 应恢复其数据');
      report('租户切换不串数据', true);
    } catch (e) {
      report('租户切换不串数据', false, e.message);
    }
    c.destroy();
  }

  // 7. 刷新不丢配置（销毁实例、新建连接模拟刷新）
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
    } catch (e) {
      report('刷新不丢配置', false, e.message);
    }
    c2.destroy();
  }

  const summary = document.createElement('h2');
  summary.className = failed === 0 ? 'pass' : 'fail';
  summary.textContent = `结果：${passed} 通过 / ${failed} 失败`;
  results.prepend(summary);
}

run().catch((e) => {
  results.innerHTML = `<div class="fail">测试运行异常: ${e.message}</div>`;
});
