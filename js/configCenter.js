// 主线程 API：封装 Worker 通信、BroadcastChannel 热更新、租户切换
export class ConfigCenter {
  constructor({ workerUrl = 'js/worker.js', dbName } = {}) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.dbName = dbName;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map(); // event -> Set<fn>
    this.clientId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random());
    this.currentTenant = localStorage.getItem('config-center:tenant:' + (dbName || '')) || 'tenant-1';
    this.effective = null;

    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };

    // 热更新：接收其它标签页 / 其它实例的变更广播
    this.channel = new BroadcastChannel('config-center:' + (dbName || 'config-center-db'));
    this.channel.onmessage = async (e) => {
      const msg = e.data;
      if (!msg || msg.kind !== 'config-changed') return;
      if (msg.source === this.clientId) return;
      this._emit('remote-change', msg);
      if (msg.tenantId === this.currentTenant || await this._isInChain(msg.tenantId)) {
        await this.refresh();
      }
    };
  }

  _call(type, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  _emit(event, data) {
    (this.listeners.get(event) || []).forEach((fn) => fn(data));
  }

  async init() {
    const r = await this._call('init', { dbName: this.dbName, clientId: this.clientId });
    await this.refresh();
    return r;
  }

  async listTenants() {
    return this._call('listTenants');
  }

  // 变更的租户是否在当前租户的继承链上（祖先变更也要热更新）
  async _isInChain(tenantId) {
    if (!this.effective) return false;
    return this.effective.chain.some((l) => l.tenantId === tenantId);
  }

  async refresh() {
    this.effective = await this._call('getEffective', { tenantId: this.currentTenant });
    this._emit('change', this.effective);
    return this.effective;
  }

  // 租户切换：清空旧数据视图，只加载新租户，互不串数据
  async switchTenant(tenantId) {
    this.currentTenant = tenantId;
    this.effective = null;
    localStorage.setItem('config-center:tenant:' + (this.dbName || ''), tenantId);
    this._emit('tenant-switching', tenantId);
    return this.refresh();
  }

  // 写入返回 { conflict: true, currentVersion, currentData } 表示冲突
  async setEntry(path, value, baseVersion) {
    const base = baseVersion !== undefined ? baseVersion : (this.effective ? this.effective.version : undefined);
    const r = await this._call('setEntry', { tenantId: this.currentTenant, path, value, baseVersion: base });
    if (!r.conflict) await this.refresh();
    return r;
  }

  async deleteEntry(path, baseVersion) {
    const base = baseVersion !== undefined ? baseVersion : (this.effective ? this.effective.version : undefined);
    const r = await this._call('deleteEntry', { tenantId: this.currentTenant, path, baseVersion: base });
    if (!r.conflict) await this.refresh();
    return r;
  }

  async getHistory() {
    return this._call('getHistory', { tenantId: this.currentTenant });
  }

  async rollback(version) {
    const r = await this._call('rollback', { tenantId: this.currentTenant, version });
    await this.refresh();
    return r;
  }

  destroy() {
    this.worker.terminate();
    this.channel.close();
  }
}
