import { ConfigCenter } from './configCenter.js';
import { flatten, getPath } from './merge.js';

const center = new ConfigCenter();
const $ = (s) => document.querySelector(s);

function log(msg) {
  const el = $('#eventLog');
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${msg}\n` + el.textContent;
}

function fmt(v) {
  return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
}

async function renderTenants() {
  const tenants = await center.listTenants();
  const sel = $('#tenantSelect');
  sel.innerHTML = '';
  for (const t of tenants) {
    const opt = document.createElement('option');
    opt.value = t.tenantId;
    opt.textContent = `${t.name} (${t.tenantId})`;
    sel.appendChild(opt);
  }
  sel.value = center.currentTenant;
}

function renderEffective(eff, flash = false) {
  $('#chainBadge').textContent = '继承链: ' + eff.chain.map((l) => l.name).join(' → ');
  const tbody = $('#configTable tbody');
  tbody.innerHTML = '';
  const own = eff.chain[eff.chain.length - 1];
  const rows = flatten(eff.config);
  for (const { path, value } of rows) {
    const src = eff.provenance[path] || '-';
    const isSelf = src === eff.tenantId;
    const ownVal = getPath(own.data, path);
    const tr = document.createElement('tr');
    if (flash) tr.className = 'flash';
    tr.innerHTML = `
      <td><code>${path}</code></td>
      <td><code>${fmt(value)}</code></td>
      <td><span class="src-badge ${isSelf ? 'self' : ''}">${src}</span></td>
      <td><input class="row-input" data-path="${path}" value='${ownVal === undefined ? '' : JSON.stringify(ownVal)}' placeholder="(未覆盖)" /></td>
      <td>
        <button class="ghost save-btn" data-path="${path}">保存</button>
        ${isSelf ? `<button class="danger del-btn" data-path="${path}">删除覆盖</button>` : ''}
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.save-btn').forEach((btn) => {
    btn.onclick = async () => {
      const path = btn.dataset.path;
      const input = tbody.querySelector(`input[data-path="${CSS.escape(path)}"]`);
      const raw = input.value.trim();
      if (!raw) return alert('请输入值（JSON 格式）');
      let value;
      try { value = JSON.parse(raw); } catch { return alert('值必须是合法 JSON'); }
      const r = await center.setEntry(path, value);
      if (r.conflict) {
        showConflict(r);
      } else {
        log(`本地写入 ${path} = ${raw} → v${r.version}`);
      }
    };
  });
  tbody.querySelectorAll('.del-btn').forEach((btn) => {
    btn.onclick = async () => {
      const r = await center.deleteEntry(btn.dataset.path);
      if (r.conflict) showConflict(r);
      else log(`删除覆盖 ${btn.dataset.path} → v${r.version}`);
    };
  });
}

async function renderHistory() {
  const list = await center.getHistory();
  const ul = $('#historyList');
  ul.innerHTML = '';
  for (const h of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="v">v${h.version}</span>
      <span class="op">${h.op}</span>
      <span class="note">${h.note || ''}</span>
      <span class="time">${new Date(h.timestamp).toLocaleString()}</span>`;
    if (h.version !== list[0].version) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = '回滚到此';
      btn.onclick = async () => {
        const r = await center.rollback(h.version);
        log(`回滚到 v${h.version}，生成新版本 v${r.version}`);
      };
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function showConflict(r) {
  $('#conflictOut').textContent =
    `检测到冲突！\n你的基线版本已过期，当前版本: v${r.currentVersion}\n` +
    `当前租户实际配置:\n${JSON.stringify(r.currentData, null, 2)}`;
  log(`冲突：写入被拒绝，当前版本 v${r.currentVersion}`);
}

async function renderAll(flash = false) {
  renderEffective(center.effective, flash);
  await renderHistory();
}

$('#tenantSelect').onchange = async (e) => {
  await center.switchTenant(e.target.value);
  log(`切换到租户 ${e.target.value}，已加载该租户数据`);
};

$('#addBtn').onclick = async () => {
  const key = $('#newKey').value.trim();
  const raw = $('#newValue').value.trim();
  if (!key || !raw) return alert('请输入键和值');
  let value;
  try { value = JSON.parse(raw); } catch { return alert('值必须是合法 JSON'); }
  const r = await center.setEntry(key, value);
  if (r.conflict) showConflict(r);
  else {
    log(`新增/覆盖 ${key} = ${raw} → v${r.version}`);
    $('#newKey').value = '';
    $('#newValue').value = '';
  }
};

$('#conflictBtn').onclick = async () => {
  // 模拟过期写入：先记住当前版本，制造一次新提交，再用旧版本号写
  const stale = center.effective.version;
  await center.setEntry('conflict.marker', Date.now());
  const r = await center.setEntry('conflict.demo', 'stale-write', stale);
  if (r.conflict) showConflict(r);
};

center.on('change', async (eff) => {
  renderEffective(eff, true);
  await renderHistory();
});

center.on('remote-change', (msg) => {
  log(`收到热更新广播：${msg.tenantId} ${msg.op} → v${msg.version}`);
});

center.on('tenant-switching', () => {
  $('#configTable tbody').innerHTML = '';
  $('#historyList').innerHTML = '';
});

await center.init();
await renderTenants();
await renderAll();
log(`初始化完成，当前租户 ${center.currentTenant}，配置版本 v${center.effective.version}`);
