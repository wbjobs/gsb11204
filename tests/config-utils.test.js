import test from "node:test";
import assert from "node:assert/strict";
import { buildTenantChain, diffConfigs, getEffectiveConfig, latestRevisionByTenant, mergeConfig, threeWayMerge } from "../js/config-utils.js";

const tenantsById = {
  global: { id: "global", parentId: null },
  cn: { id: "cn", parentId: "global" },
  vip: { id: "vip", parentId: "cn" },
};

test("继承链按照根到当前租户返回", () => {
  assert.deepEqual(buildTenantChain("vip", tenantsById), ["vip", "cn", "global"]);
});

test("对象深度合并且叶子配置由最近租户覆盖", () => {
  const revisions = [
    revision("global", 1, { theme: { mode: "light", brand: "blue" }, limits: { projects: 10, members: 20 }, feature: { beta: false } }),
    revision("cn", 1, { theme: { brand: "red" }, limits: { projects: 25 } }),
    revision("vip", 1, { feature: { beta: true }, limits: { members: 100 } }),
  ];
  const result = getEffectiveConfig("vip", tenantsById, latestRevisionByTenant(revisions));
  assert.deepEqual(result.config, {
    theme: { mode: "light", brand: "red" },
    limits: { projects: 25, members: 100 },
    feature: { beta: true },
  });
});

test("数组和标量作为叶子整体覆盖", () => {
  assert.deepEqual(mergeConfig({ items: [1, 2], meta: { keep: true } }, { items: [3], meta: { keep: false } }), { items: [3], meta: { keep: false } });
  assert.deepEqual(mergeConfig({ value: { nested: true } }, { value: false }), { value: false });
});

test("不同路径的并发修改可以自动合并", () => {
  const result = threeWayMerge({ a: 1, nested: { x: 1, y: 2 } }, { a: 2, nested: { x: 1, y: 2 } }, { a: 1, nested: { x: 3, y: 2 } });
  assert.deepEqual(result.merged, { a: 2, nested: { x: 3, y: 2 } });
  assert.equal(result.conflicts.length, 0);
});

test("同一路径的并发修改产生冲突", () => {
  const result = threeWayMerge({ a: 1 }, { a: 2 }, { a: 3 });
  assert.deepEqual(result.merged, { a: 3 });
  assert.deepEqual(result.conflicts, [{ path: "a", baseValue: 1, localValue: 2, remoteValue: 3 }]);
});

test("删除与修改同一字段产生冲突", () => {
  const result = threeWayMerge({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 3 });
  assert.equal(result.conflicts.some((item) => item.path === "b"), true);
  assert.equal(result.conflicts[0].remoteValue, 3);
});

test("对象和标量的并发替换产生冲突", () => {
  const result = threeWayMerge({ value: { enabled: true } }, { value: false }, { value: true });
  assert.deepEqual(result.conflicts, [{ path: "value", baseValue: { enabled: true }, localValue: false, remoteValue: true }]);
});

test("配置差异能识别新增、修改、删除", () => {
  const changes = diffConfigs({ addedLater: 0, changed: 1, removed: true }, { addedLater: 1, changed: 2, created: true });
  const byPath = Object.fromEntries(changes.map((change) => [change.path, change.type]));
  assert.deepEqual(byPath, { addedLater: "changed", changed: "changed", removed: "removed", created: "added" });
});

test("继承链循环会被检测", () => {
  assert.throws(() => buildTenantChain("a", { a: { id: "a", parentId: "b" }, b: { id: "b", parentId: "a" } }), new RegExp("循环"));
});

function revision(tenantId, version, config) {
  return { id: `${tenantId}-${version}`, tenantId, version, config };
}
