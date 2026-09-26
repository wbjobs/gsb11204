// 配置合并：继承链从根到叶子依次深合并，叶子（当前租户）优先级最高
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

// levels: [{ tenantId, data }] 从根（全局）到叶子（当前租户）
// 返回 { config, provenance }，provenance 记录每个叶子键由哪一层提供
export function mergeChain(levels) {
  const config = {};
  const provenance = {};
  for (const level of levels) {
    applyLevel(config, provenance, level.data || {}, level.tenantId, '');
  }
  return { config, provenance };
}

function applyLevel(target, provenance, src, tenantId, path) {
  for (const [k, v] of Object.entries(src)) {
    const p = path ? path + '.' + k : k;
    if (isPlainObject(v)) {
      if (!isPlainObject(target[k])) target[k] = {};
      applyLevel(target[k], provenance, v, tenantId, p);
    } else {
      target[k] = v;
      provenance[p] = tenantId;
    }
  }
}

// 按路径取值，'a.b.c'
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// 按路径设值（不可变），返回新对象
export function setPath(obj, path, value) {
  const keys = path.split('.');
  const root = { ...obj };
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = isPlainObject(cur[k]) ? { ...cur[k] } : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

// 按路径删除（不可变），并清理空父对象
export function deletePath(obj, path) {
  const keys = path.split('.');
  function del(node, depth) {
    if (!isPlainObject(node)) return node;
    const copy = { ...node };
    if (depth === keys.length - 1) {
      delete copy[keys[depth]];
    } else if (keys[depth] in copy) {
      const child = del(copy[keys[depth]], depth + 1);
      if (isPlainObject(child) && Object.keys(child).length === 0) {
        delete copy[keys[depth]];
      } else {
        copy[keys[depth]] = child;
      }
    }
    return copy;
  }
  return del(obj, 0);
}

// 拍平为 [{ path, value }]，仅叶子
export function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? prefix + '.' + k : k;
    if (isPlainObject(v)) out.push(...flatten(v, p));
    else out.push({ path: p, value: v });
  }
  return out;
}
