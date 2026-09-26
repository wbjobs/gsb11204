import {
  buildTenantChain,
  cloneJson,
  deepEqual,
  isPlainContainer,
  nowIso,
  threeWayMerge,
} from "./config-utils.js";

const DB_NAME = "tenant-config-center";
const DB_VERSION = 1;
const STORES = {
  tenants: "tenants",
  revisions: "revisions",
};

const channel = new BroadcastChannel("tenant-config-center-v1");

channel.addEventListener("message", (event) => {
  if (event.data?.origin !== tabId) {
    self.postMessage({ event: true, ...event.data });
  }
});

const tabId = crypto.randomUUID();

self.addEventListener("message", async (event) => {
  const request = event.data;
  try {
    await handleRequest(request);
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function handleRequest(request) {
  const db = await openDatabase();
  if (request.type === "init") {
    const tenants = await getAll(db, STORES.tenants);
    const revisions = await getAll(db, STORES.revisions);
    respond(request.id, { ok: true, tabId, tenants, revisions });
    return;
  }
  if (request.type === "createTenant") {
    const result = await createTenant(db, request);
    respond(request.id, result);
    return;
  }
  if (request.type === "saveRevision") {
    const result = await saveRevision(db, request);
    respond(request.id, result);
    return;
  }
  if (request.type === "rollback") {
    const result = await rollback(db, request);
    respond(request.id, result);
    return;
  }
  throw new Error(`未知请求：${request.type}`);
}

function respond(id, payload) {
  self.postMessage({ id, ...payload });
}

function openDatabase() {
  return idbRequest(indexedDB.open(DB_NAME, DB_VERSION), (request) => {
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.tenants)) db.createObjectStore(STORES.tenants, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.revisions)) db.createObjectStore(STORES.revisions, { keyPath: "id" });
    };
  }).then(async (db) => {
    await seedIfNeeded(db);
    return db;
  });
}

async function seedIfNeeded(db) {
  const existingTenants = await getAll(db, STORES.tenants);
  if (existingTenants.length > 0) return;
  const tenants = [
    { id: "global", name: "全局", parentId: null, createdAt: nowIso() },
    { id: "cn", name: "中国区", parentId: "global", createdAt: nowIso() },
    { id: "cn-vip", name: "中国区 VIP", parentId: "cn", createdAt: nowIso() },
  ];
  const revisions = [
    revision("global", 1, {
      theme: { mode: "light", brand: "#2563eb" },
      features: { audit: true, beta: false },
      limits: { maxProjects: 10, maxMembers: 20 },
    }, "初始全局配置"),
    revision("cn", 1, {
      locale: "zh-CN",
      theme: { brand: "#dc2626" },
      limits: { maxProjects: 25 },
    }, "初始区域配置"),
    revision("cn-vip", 1, {
      features: { beta: true },
      limits: { maxMembers: 100 },
    }, "初始 VIP 租户配置"),
  ];
  await transaction(db, [STORES.tenants, STORES.revisions], "readwrite", (stores) => {
    tenants.forEach((tenant) => stores.tenants.add(tenant));
    revisions.forEach((item) => stores.revisions.add(item));
  });
}

function revision(tenantId, version, config, message) {
  return {
    id: `${tenantId}-v${version}-${crypto.randomUUID()}`,
    tenantId,
    version,
    config: cloneJson(config),
    message,
    author: "system",
    createdAt: nowIso(),
  };
}

async function createTenant(db, request) {
  const { id, name, parentId } = request;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(id || "")) throw new Error("租户 ID 需为 1-32 位字母、数字或短横线");
  if (!name?.trim()) throw new Error("租户名称不能为空");
  const config = {};
  let tenant;
  await transaction(db, [STORES.tenants, STORES.revisions], "readwrite", (stores) => {
    const tenants = requestAll(stores.tenants.getAll());
    const parent = parentId ? requestGet(stores.tenants.get(parentId)) : null;
    return Promise.all([tenants, parent]).then(([allTenants, parentTenant]) => {
      if (allTenants.some((item) => item.id === id)) throw new Error("租户 ID 已存在");
      if (parentId && !parentTenant) throw new Error("父租户不存在");
      const tenantsById = Object.fromEntries(allTenants.map((item) => [item.id, item]));
      if (parentId) buildTenantChain(parentId, tenantsById);
      tenant = { id, name: name.trim(), parentId: parentId || null, createdAt: nowIso() };
      stores.tenants.add(tenant);
      stores.revisions.add(revision(id, 1, config, "创建租户"));
    });
  });
  const event = { type: "tenant-created", tenant, origin: tabId, at: nowIso() };
  channel.postMessage(event);
  return { ok: true, tenant, revision: await getLatestRevision(db, id) };
}

async function saveRevision(db, request) {
  const { tenantId, config, baseVersion, mode = "detect", message, author = "当前用户" } = request;
  if (!isPlainContainer(config)) throw new Error("配置必须是 JSON 对象，且不能包含 __proto__ 等危险键");
  if (!message?.trim()) throw new Error("版本说明不能为空");

  let saved;
  let mergeReport = null;
  let conflictResult = null;
  await transaction(db, [STORES.tenants, STORES.revisions], "readwrite", (stores) => {
    return Promise.all([
      requestGet(stores.tenants.get(tenantId)),
      requestAll(stores.revisions.getAll()),
    ]).then(([tenant, allRevisions]) => {
      if (!tenant) throw new Error("租户不存在");
      const tenantRevisions = allRevisions
        .filter((item) => item.tenantId === tenantId)
        .sort((left, right) => left.version - right.version);
      const latest = tenantRevisions.at(-1);
      const base = tenantRevisions.find((item) => item.version === baseVersion);
      if (!base) throw new Error("基准版本不存在，请刷新后重试");

      let nextConfig = cloneJson(config);
      if (latest.version !== baseVersion) {
        if (mode === "force") {
          mergeReport = { mode: "force", conflicts: [] };
        } else if (mode === "merge") {
          const result = threeWayMerge(base.config, config, latest.config);
          if (result.conflicts.length > 0) {
            conflictResult = {
              ok: false,
              error: "检测到冲突",
              code: "CONFLICT",
              conflicts: result.conflicts,
              latest,
            };
            return;
          }
          nextConfig = result.merged;
          mergeReport = { mode: "auto-merge", conflicts: [] };
        } else {
          const result = threeWayMerge(base.config, config, latest.config);
          conflictResult = {
            ok: false,
            error: "配置已被其他标签页更新",
            code: "CONFLICT",
            conflicts: result.conflicts,
            latest,
          };
          return;
        }
      }

      if (deepEqual(latest.config, nextConfig)) throw new Error("配置没有变化");
      saved = revision(tenantId, latest.version + 1, nextConfig, message.trim());
      saved.author = author;
      stores.revisions.add(saved);
    });
  });

  if (conflictResult) return conflictResult;

  const event = { type: "config-changed", tenantId, revision: saved, origin: tabId, at: nowIso() };
  channel.postMessage(event);
  return { ok: true, revision: saved, mergeReport };
}

async function rollback(db, request) {
  const { tenantId, targetVersion, message, author = "当前用户" } = request;
  let saved;
  await transaction(db, [STORES.tenants, STORES.revisions], "readwrite", (stores) => {
    return Promise.all([
      requestGet(stores.tenants.get(tenantId)),
      requestAll(stores.revisions.getAll()),
    ]).then(([tenant, allRevisions]) => {
      if (!tenant) throw new Error("租户不存在");
      const tenantRevisions = allRevisions
        .filter((item) => item.tenantId === tenantId)
        .sort((left, right) => left.version - right.version);
      const latest = tenantRevisions.at(-1);
      const target = tenantRevisions.find((item) => item.version === targetVersion);
      if (!target) throw new Error("回滚目标版本不存在");
      if (deepEqual(latest.config, target.config)) throw new Error("当前版本与目标版本一致");
      saved = revision(
        tenantId,
        latest.version + 1,
        target.config,
        message?.trim() || `回滚到 v${target.version}`,
      );
      saved.author = author;
      stores.revisions.add(saved);
    });
  });
  const event = { type: "config-changed", tenantId, revision: saved, origin: tabId, at: nowIso() };
  channel.postMessage(event);
  return { ok: true, revision: saved };
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(db, storeNames, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    let result;
    Promise.resolve()
      .then(() => callback(stores))
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        tx.abort();
        reject(error);
      });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbRequest(target, configure) {
  return new Promise((resolve, reject) => {
    const request = target();
    configure?.(request);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestGet(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestAll(request) {
  return requestGet(request);
}
