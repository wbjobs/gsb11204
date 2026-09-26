const ABSENT = Symbol("absent");

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => deepEqual(left[key], right[key]));
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPlainContainer(value) {
  if (Array.isArray(value)) return value.every(isPlainContainer);
  if (!isObject(value)) return JSONCompatiblePrimitive(value);
  return Object.entries(value).every(([key, child]) => !isForbiddenKey(key) && isPlainContainer(child));
}

function JSONCompatiblePrimitive(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function isForbiddenKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

export function buildTenantChain(tenantId, tenantsById, seen = new Set()) {
  const tenant = tenantsById[tenantId];
  if (!tenant) throw new Error(`租户不存在：${tenantId}`);
  if (seen.has(tenantId)) throw new Error(`租户继承链存在循环：${[...seen, tenantId].join(" → ")}`);
  seen.add(tenantId);
  return tenant.parentId
    ? [tenantId, ...buildTenantChain(tenant.parentId, tenantsById, seen)]
    : [tenantId];
}

export function latestRevisionByTenant(revisions) {
  const latest = new Map();
  for (const revision of revisions) {
    const current = latest.get(revision.tenantId);
    if (!current || revision.version > current.version) latest.set(revision.tenantId, revision);
  }
  return latest;
}

export function getEffectiveConfig(tenantId, tenantsById, latestByTenant) {
  const chain = buildTenantChain(tenantId, tenantsById);
  let config = {};
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const revision = latestByTenant.get(chain[index]);
    config = mergeConfig(config, revision?.config ?? {});
  }
  return { chain, config };
}

export function mergeConfig(base, override) {
  if (!isObject(base) || !isObject(override)) return cloneJson(override);
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isForbiddenKey(key)) result[key] = cloneJson(value);
  }
  for (const [key, overrideValue] of Object.entries(override)) {
    if (isForbiddenKey(key)) continue;
    result[key] = isObject(result[key]) && isObject(overrideValue)
      ? mergeConfig(result[key], overrideValue)
      : cloneJson(overrideValue);
  }
  return result;
}

export function flattenConfig(value, prefix = "") {
  const result = {};
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      Object.assign(result, flattenConfig(child, path));
    }
    return result;
  }
  result[prefix || "$"] = cloneJson(value);
  return result;
}

export function findEffectiveSource(path, chain, latestByTenant) {
  for (const tenantId of chain) {
    const revision = latestByTenant.get(tenantId);
    if (!revision) continue;
    const value = getPathValue(revision.config, path);
    if (value !== ABSENT) {
      return { tenantId, version: revision.version, value: cloneJson(value) };
    }
  }
  return null;
}

export function getPathValue(root, path) {
  let current = root;
  const parts = path.split(".").filter(Boolean);
  for (const part of parts) {
    if (!isObject(current) || !(part in current)) return ABSENT;
    current = current[part];
  }
  return current;
}

export function diffConfigs(base, next) {
  const changes = [];
  const baseFlat = flattenConfig(base);
  const nextFlat = flattenConfig(next);
  for (const path of new Set([...Object.keys(baseFlat), ...Object.keys(nextFlat)])) {
    if (!Object.hasOwn(nextFlat, path)) {
      changes.push({ type: "removed", path, oldValue: cloneJson(baseFlat[path]) });
    } else if (!Object.hasOwn(baseFlat, path)) {
      changes.push({ type: "added", path, newValue: cloneJson(nextFlat[path]) });
    } else if (!deepEqual(baseFlat[path], nextFlat[path])) {
      changes.push({ type: "changed", path, oldValue: cloneJson(baseFlat[path]), newValue: cloneJson(nextFlat[path]) });
    }
  }
  return changes;
}

export function summarizeChanges(changes) {
  return changes
    .map((change) => {
      if (change.type === "removed") return `删除 ${change.path}`;
      if (change.type === "added") return `新增 ${change.path}`;
      return `修改 ${change.path}`;
    })
    .join("；") || "无配置变化";
}

export function threeWayMerge(base, current, incoming) {
  const conflicts = [];
  const merged = threeWayMergeValue(base ?? {}, current ?? {}, incoming ?? {}, [], conflicts);
  return { merged, conflicts };
}

function threeWayMergeValue(baseValue, currentValue, incomingValue, path, conflicts) {
  if (deepEqual(currentValue, incomingValue)) return cloneJson(currentValue);
  if (deepEqual(currentValue, baseValue)) return cloneJson(incomingValue);
  if (deepEqual(incomingValue, baseValue)) return cloneJson(currentValue);

  if (isObject(baseValue) || isObject(currentValue) || isObject(incomingValue)) {
    if (![baseValue, currentValue, incomingValue].every((value) => value === undefined || isObject(value))) {
      pushConflict(path, baseValue, currentValue, incomingValue, conflicts);
      return cloneJson(incomingValue);
    }
    const keys = new Set([
      ...Object.keys(baseValue ?? {}),
      ...Object.keys(currentValue ?? {}),
      ...Object.keys(incomingValue ?? {}),
    ]);
    const result = {};
    for (const key of keys) {
      if (isForbiddenKey(key)) continue;
      const childPath = [...path, key];
      const nextBase = getChildValue(baseValue, key);
      const nextCurrent = getChildValue(currentValue, key);
      const nextIncoming = getChildValue(incomingValue, key);
      if (nextCurrent === ABSENT && nextIncoming === ABSENT) continue;
      if (nextCurrent === ABSENT && deepEqual(nextBase, nextIncoming)) {
        continue;
      }
      if (nextIncoming === ABSENT && deepEqual(nextBase, nextCurrent)) {
        continue;
      }
      if (nextCurrent === ABSENT || nextIncoming === ABSENT) {
        pushConflict(childPath, nextBase, nextCurrent, nextIncoming, conflicts);
      } else {
        result[key] = threeWayMergeValue(nextBase, nextCurrent, nextIncoming, childPath, conflicts);
      }
    }
    return result;
  }

  pushConflict(path, baseValue, currentValue, incomingValue, conflicts);
  return cloneJson(incomingValue);
}

function getChildValue(parent, key) {
  if (!isObject(parent) || !Object.hasOwn(parent, key)) return ABSENT;
  return parent[key];
}

function pushConflict(path, baseValue, currentValue, incomingValue, conflicts) {
  conflicts.push({
    path: path.join("."),
    baseValue: baseValue === ABSENT ? undefined : cloneJson(baseValue),
    localValue: currentValue === ABSENT ? undefined : cloneJson(currentValue),
    remoteValue: incomingValue === ABSENT ? undefined : cloneJson(incomingValue),
  });
}

export function describeValue(value) {
  if (value === undefined) return "<已删除>";
  return JSON.stringify(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export { ABSENT };
