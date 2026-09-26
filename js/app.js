import { StorageClient } from "./storage-client.js";
import {
  cloneJson,
  describeValue,
  diffConfigs,
  flattenConfig,
  getEffectiveConfig,
  isForbiddenKey,
  isPlainContainer,
  latestRevisionByTenant,
  summarizeChanges,
  threeWayMerge,
} from "./config-utils.js";

const $ = (id) => document.getElementById(id);

const els = {
  workerStatus: $("workerStatus"),
  tenantCount: $("tenantCount"),
  tenantList: $("tenantList"),
  tenantForm: $("tenantForm"),
  newTenantId: $("newTenantId"),
  newTenantName: $("newTenantName"),
  newTenantParent: $("newTenantParent"),
  currentTenantName: $("currentTenantName"),
  inheritanceChain: $("inheritanceChain"),
  hotBanner: $("hotBanner"),
  editorVersion: $("editorVersion"),
  configEditor: $("configEditor"),
  validation: $("validation"),
  revisionMessage: $("revisionMessage"),
  formatButton: $("formatButton"),
  resetButton: $("resetButton"),
  saveButton: $("saveButton"),
  previewMode: $("previewMode"),
  effectivePreview: $("effectivePreview"),
  sourceTable: $("sourceTable"),
  conflictPanel: $("conflictPanel"),
  conflictList: $("conflictList"),
  dismissConflict: $("dismissConflict"),
  loadRemoteButton: $("loadRemoteButton"),
  mergeButton: $("mergeButton"),
  forceButton: $("forceButton"),
  historyList: $("historyList"),
  toast: $("toast"),
};

const state = {
  tenants: [],
  revisions: [],
  selectedTenantId: "global",
  drafts: {},
  editorBaseVersion: 1,
  conflict: null,
  lastEventAt: null,
};

const client = new StorageClient(new URL("./db-worker.js", import.meta.url));

init();

async function init() {
  bindEvents();
  try {
    const result = await client.init();
    state.tenants = result.tenants;
    state.revisions = result.revisions;
    state.selectedTenantId = state.tenants.some((tenant) => tenant.id === "global") ? "global" : state.tenants[0]?.id;
    state.drafts = Object.fromEntries(state.tenants.map((tenant) => [tenant.id, getRawConfig(tenant.id)]));
    selectTenant(state.selectedTenantId);
    els.workerStatus.textContent = "Worker 已连接";
    els.workerStatus.classList.add("ok");
  } catch (error) {
    els.workerStatus.textContent = "Worker 启动失败";
    els.workerStatus.classList.add("error");
    showToast(error.message, true);
  }
}

function bindEvents() {
  els.tenantList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tenant-id]");
    if (button) selectTenant(button.dataset.tenantId);
  });
  els.tenantForm.addEventListener("submit", handleCreateTenant);
  els.configEditor.addEventListener("input", handleEditorInput);
  els.formatButton.addEventListener("click", formatDraft);
  els.resetButton.addEventListener("click", resetDraft);
  els.saveButton.addEventListener("click", () => saveDraft("detect"));
  els.dismissConflict.addEventListener("click", () => setConflict(null));
  els.loadRemoteButton.addEventListener("click", loadRemoteVersion);
  els.mergeButton.addEventListener("click", () => applyAutoMerge(true));
  els.forceButton.addEventListener("click", () => saveDraft("force"));
  els.historyList.addEventListener("click", handleHistoryClick);
  client.addEventListener("config-changed", handleRemoteConfigChanged);
  client.addEventListener("tenant-created", handleRemoteTenantCreated);
}

function tenantsById() {
  return Object.fromEntries(state.tenants.map((tenant) => [tenant.id, tenant]));
}

function latestByTenantMap() {
  return latestRevisionByTenant(state.revisions);
}

function selectedTenant() {
  return state.tenants.find((tenant) => tenant.id === state.selectedTenantId);
}

function currentRevision() {
  return latestByTenantMap().get(state.selectedTenantId);
}

function getRawConfig(tenantId) {
  return cloneJson(latestByTenantMap().get(tenantId)?.config ?? {});
}

function selectTenant(tenantId) {
  saveCurrentDraft();
  state.selectedTenantId = tenantId;
  const revision = latestByTenantMap().get(tenantId);
  state.editorBaseVersion = revision?.version ?? 1;
  setConflict(null);
  if (!(tenantId in state.drafts)) state.drafts[tenantId] = cloneJson(revision?.config ?? {});
  els.configEditor.value = JSON.stringify(state.drafts[tenantId], null, 2);
  els.revisionMessage.value = "";
  setHotBanner(null);
  render();
  validateEditor();
}

function setHotBanner(message) {
  els.hotBanner.textContent = message || "";
  els.hotBanner.classList.toggle("hidden", !message);
}

function saveCurrentDraft() {
  const parsed = parseEditor();
  if (parsed.ok) state.drafts[state.selectedTenantId] = parsed.value;
}

function parseEditor() {
  try {
    const value = JSON.parse(els.configEditor.value);
    if (!isPlainContainer(value)) return { ok: false, error: "配置必须是 JSON 对象，数组不能作为根配置" };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function handleEditorInput() {
  const parsed = parseEditor();
  if (parsed.ok) {
    state.drafts[state.selectedTenantId] = parsed.value;
    renderEffectivePreview(parsed.value, "草稿预览（尚未发布）");
  } else {
    els.previewMode.textContent = "JSON 解析失败";
  }
  validateEditor();
}

function validateEditor() {
  const parsed = parseEditor();
  els.validation.className = "validation";
  if (parsed.ok) {
    const revision = currentRevision();
    const changes = revision ? diffConfigs(revision.config, parsed.value) : [];
    els.validation.textContent = changes.length ? `草稿包含 ${changes.length} 项变化：${summarizeChanges(changes)}` : "配置无变化";
    els.validation.classList.add("ok");
  } else {
    els.validation.textContent = `JSON 无效：${parsed.error}`;
    els.validation.classList.add("error");
  }
  return parsed;
}

function render() {
  renderTenants();
  renderChain();
  renderEditorHeader();
  renderEffectivePreview(state.drafts[state.selectedTenantId], "草稿预览（尚未发布）");
  renderHistory();
}

function renderTenants() {
  els.tenantCount.textContent = `${state.tenants.length} 个`;
  els.tenantList.innerHTML = state.tenants.map((tenant) => {
    const tenants = tenantsById();
    const parent = tenant.parentId ? tenants[tenant.parentId]?.name ?? tenant.parentId : "无";
    return `
      <button type="button" class="tenant-item ${tenant.id === state.selectedTenantId ? "active" : ""}" data-tenant-id="${escapeHtml(tenant.id)}">
        <strong>${escapeHtml(tenant.name)}</strong>
        <small>${escapeHtml(tenant.id)} · 继承 ${escapeHtml(parent)}</small>
      </button>
    `;
  }).join("");

  els.newTenantParent.innerHTML = `<option value="">无（全局根租户）</option>` + state.tenants
    .map((tenant) => `<option value="${escapeHtml(tenant.id)}">${escapeHtml(tenant.name)}（${escapeHtml(tenant.id)}）</option>`)
    .join("");
}

function renderChain() {
  const tenant = selectedTenant();
  els.currentTenantName.textContent = tenant ? `${tenant.name}（${tenant.id}）` : "-";
  try {
    const latest = latestByTenantMap();
    const { chain } = getEffectiveConfig(state.selectedTenantId, tenantsById(), latest);
    els.inheritanceChain.innerHTML = chain
      .slice()
      .reverse()
      .map((id) => {
        const item = tenantsById()[id];
        const version = latest.get(id)?.version;
        return `<span>${escapeHtml(item?.name ?? id)} · v${version ?? "-"}</span>`;
      })
      .join("<span>→</span>");
  } catch (error) {
    els.inheritanceChain.innerHTML = `<span>${escapeHtml(error.message)}</span>`;
  }
}

function renderEditorHeader() {
  const revision = currentRevision();
  els.editorVersion.textContent = revision ? `基于已发布 v${revision.version}` : "尚无版本";
}

function renderEffectivePreview(overrideConfig, modeText) {
  try {
    const effective = calculateWithOverride(overrideConfig);
    els.previewMode.textContent = modeText;
    els.effectivePreview.textContent = JSON.stringify(effective.config, null, 2);
    renderSources(effective.chain, overrideConfig);
  } catch (error) {
    els.previewMode.textContent = "继承链异常";
    els.effectivePreview.textContent = error.message;
    els.sourceTable.innerHTML = "";
  }
}

function calculateWithOverride(overrideConfig) {
  const latest = latestByTenantMap();
  const { chain } = getEffectiveConfig(state.selectedTenantId, tenantsById(), latest);
  let config = {};
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const id = chain[index];
    const sourceConfig = id === state.selectedTenantId
      ? overrideConfig
      : latest.get(id)?.config ?? {};
    config = deepMergeForRender(config, sourceConfig);
  }
  return { chain, config };
}

function deepMergeForRender(base, override) {
  const result = cloneJson(base);
  for (const [key, value] of Object.entries(override)) {
    if (isForbiddenKey(key)) continue;
    result[key] = isPlainObject(result[key]) && isPlainObject(value)
      ? deepMergeForRender(result[key], value)
      : cloneJson(value);
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderSources(chain, overrideConfig) {
  const effective = calculateWithOverride(overrideConfig);
  const flat = flattenConfig(effective.config);
  const draftByTenant = new Map([[state.selectedTenantId, overrideConfig]]);
  const rows = [
    `<div class="source-row header"><span>路径</span><span>来源租户</span><span>值</span></div>`,
    ...Object.entries(flat).map(([path, value]) => {
      const source = findSourceInChain(path, chain.slice(), draftByTenant);
      return `
        <div class="source-row">
          <code>${escapeHtml(path)}</code>
          <span>${source ? escapeHtml(source) : "-"}</span>
          <code>${escapeHtml(JSON.stringify(value))}</code>
        </div>
      `;
    }),
  ];
  els.sourceTable.innerHTML = rows.join("");
}

function findSourceInChain(path, chain, draftByTenant) {
  const tenants = tenantsById();
  const latest = latestByTenantMap();
  for (const tenantId of chain) {
    const config = draftByTenant.get(tenantId) ?? latest.get(tenantId)?.config;
    if (config && hasPath(config, path)) return tenants[tenantId]?.name ?? tenantId;
  }
  return null;
}

function hasPath(root, path) {
  let current = root;
  for (const part of path.split(".")) {
    if (!isPlainObject(current) || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function formatDraft() {
  const parsed = parseEditor();
  if (!parsed.ok) {
    showToast("无法格式化：JSON 无效", true);
    return;
  }
  els.configEditor.value = JSON.stringify(parsed.value, null, 2);
  handleEditorInput();
}

function resetDraft() {
  const config = getRawConfig(state.selectedTenantId);
  state.drafts[state.selectedTenantId] = config;
  els.configEditor.value = JSON.stringify(config, null, 2);
  setConflict(null);
  handleEditorInput();
  showToast("草稿已重置为当前已发布版本");
}

async function saveDraft(mode) {
  const parsed = parseEditor();
  if (!parsed.ok) {
    showToast(`无法发布：${parsed.error}`, true);
    return;
  }
  const message = els.revisionMessage.value.trim();
  if (!message) {
    showToast("请填写版本说明", true);
    return;
  }
  setBusy(true);
  try {
    const result = await client.saveRevision(state.selectedTenantId, parsed.value, state.editorBaseVersion, mode, message);
    applySavedRevision(result.revision, "配置已发布并热更新");
  } catch (error) {
    if (error.code === "CONFLICT") {
      setConflict({ baseVersion: state.editorBaseVersion, latest: error.latest, conflicts: error.conflicts, mode });
    } else {
      showToast(error.message, true);
    }
  } finally {
    setBusy(false);
  }
}

function applySavedRevision(revision, toastMessage) {
  state.revisions = state.revisions.filter((item) => item.id !== revision.id);
  state.revisions.push(revision);
  state.drafts[state.selectedTenantId] = cloneJson(revision.config);
  state.editorBaseVersion = revision.version;
  els.configEditor.value = JSON.stringify(revision.config, null, 2);
  els.revisionMessage.value = "";
  setConflict(null);
  setHotBanner(null);
  render();
  validateEditor();
  showToast(toastMessage);
}

function setConflict(conflict) {
  state.conflict = conflict;
  els.conflictPanel.classList.toggle("hidden", !conflict);
  if (!conflict) return;
  els.conflictList.innerHTML = conflict.conflicts.length
    ? conflict.conflicts.map((item) => `
      <div class="conflict-item">
        <strong>${escapeHtml(item.path)}</strong>
        <dl>
          <dt>本地</dt><dd>${escapeHtml(describeValue(item.localValue))}</dd>
          <dt>远端</dt><dd>${escapeHtml(describeValue(item.remoteValue))}</dd>
          <dt>旧基准</dt><dd>${escapeHtml(describeValue(item.baseValue))}</dd>
        </dl>
      </div>`).join("")
    : `<div class="conflict-item">同一路径没有叶子冲突；不同字段可以自动合并。</div>`;
}

function loadRemoteVersion() {
  const latest = state.conflict?.latest;
  if (!latest) return;
  state.drafts[state.selectedTenantId] = cloneJson(latest.config);
  state.editorBaseVersion = latest.version;
  els.configEditor.value = JSON.stringify(latest.config, null, 2);
  setConflict(null);
  render();
  validateEditor();
  showToast(`已载入远端 v${latest.version}`);
}

async function applyAutoMerge(saveAfterMerge) {
  const conflict = state.conflict;
  if (!conflict) return;
  const parsed = parseEditor();
  if (!parsed.ok) return showToast(parsed.error, true);
  const baseRevision = state.revisions
    .filter((item) => item.tenantId === state.selectedTenantId && item.version === conflict.baseVersion)
    .at(0);
  if (!baseRevision) return showToast("旧基准版本不存在，请载入远端版本", true);
  const result = threeWayMerge(baseRevision.config, parsed.value, conflict.latest.config);
  if (result.conflicts.length > 0) {
    setConflict({ ...conflict, conflicts: result.conflicts });
    return showToast("仍有同路径冲突，请选择载入远端或强制覆盖", true);
  }
  state.drafts[state.selectedTenantId] = result.merged;
  state.editorBaseVersion = conflict.latest.version;
  els.configEditor.value = JSON.stringify(result.merged, null, 2);
  if (!saveAfterMerge) {
    setConflict(null);
    render();
    validateEditor();
    return;
  }
  try {
    const saved = await client.saveRevision(
      state.selectedTenantId,
      result.merged,
      conflict.latest.version,
      "merge",
      els.revisionMessage.value.trim() || "自动合并非冲突变更",
    );
    applySavedRevision(saved.revision, "自动合并并发布成功");
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderHistory() {
  const revisions = state.revisions
    .filter((item) => item.tenantId === state.selectedTenantId)
    .sort((left, right) => right.version - left.version);
  els.historyList.innerHTML = revisions.map((item, index) => `
    <div class="history-row">
      <span class="version">v${item.version}</span>
      <div>
        <strong>${escapeHtml(item.message)}</strong>
        <div class="history-meta">${escapeHtml(formatTime(item.createdAt))} · ${escapeHtml(item.author)}${index === 0 ? " · 当前版本" : ""}</div>
      </div>
      ${index === 0 ? "" : `<button type="button" class="secondary" data-rollback-version="${item.version}">回滚到此版本</button>`}
    </div>`).join("");
}

async function handleHistoryClick(event) {
  const button = event.target.closest("[data-rollback-version]");
  if (!button) return;
  setBusy(true);
  try {
    const result = await client.rollback(state.selectedTenantId, Number(button.dataset.rollbackVersion));
    applySavedRevision(result.revision, `已回滚并生成 v${result.revision.version}`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function handleCreateTenant(event) {
  event.preventDefault();
  try {
    const result = await client.createTenant(
      els.newTenantId.value.trim(),
      els.newTenantName.value.trim(),
      els.newTenantParent.value,
    );
    state.tenants.push(result.tenant);
    state.revisions.push(result.revision);
    state.drafts[result.tenant.id] = cloneJson(result.revision.config);
    els.tenantForm.reset();
    selectTenant(result.tenant.id);
    showToast("租户已创建");
  } catch (error) {
    showToast(error.message, true);
  }
}

function handleRemoteConfigChanged(event) {
  const { tenantId, revision, at } = event.detail;
  if (!tenantId || !revision) return;
  state.revisions = state.revisions
    .filter((item) => item.tenantId !== tenantId || item.version !== revision.version)
    .concat(revision)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  state.lastEventAt = at;

  if (tenantId === state.selectedTenantId) {
    if (state.editorBaseVersion < revision.version) {
      const parsed = parseEditor();
      const base = state.revisions.find((item) => item.tenantId === tenantId && item.version === state.editorBaseVersion);
      const mergeResult = parsed.ok && base ? threeWayMerge(base.config, parsed.value, revision.config) : null;
      if (mergeResult && mergeResult.conflicts.length === 0) {
        state.drafts[tenantId] = mergeResult.merged;
        state.editorBaseVersion = revision.version;
        els.configEditor.value = JSON.stringify(mergeResult.merged, null, 2);
        setHotBanner(`其他标签页发布的 v${revision.version} 已即时合入当前草稿。`);
      } else {
        setHotBanner(`其他标签页已发布 v${revision.version}：${revision.message}。当前草稿保留，请处理同路径冲突。`);
      }
      if (!state.conflict) {
        if (mergeResult && mergeResult.conflicts.length > 0) {
          setConflict({ baseVersion: state.editorBaseVersion, latest: revision, conflicts: mergeResult.conflicts, mode: "remote" });
        }
      }
    } else {
      state.drafts[tenantId] = cloneJson(revision.config);
      state.editorBaseVersion = revision.version;
      els.configEditor.value = JSON.stringify(revision.config, null, 2);
    }
  }
  render();
  validateEditor();
}

function handleRemoteTenantCreated(event) {
  const { tenant } = event.detail;
  if (!tenant || state.tenants.some((item) => item.id === tenant.id)) return;
  state.tenants.push(tenant);
  state.drafts[tenant.id] = {};
  render();
  showToast(`其他标签页创建了租户：${tenant.name}`);
}

function setBusy(isBusy) {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function escapeHtml(value) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  return String(value).replace(/[&<>]/g, (char) => replacements[char]);
}

function formatTime(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.style.background = isError ? "#7f1d1d" : "#0f172a";
  els.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3600);
}
