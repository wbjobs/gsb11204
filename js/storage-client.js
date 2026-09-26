export class StorageClient extends EventTarget {
  constructor(workerUrl) {
    super();
    this.tabId = null;
    this.pending = new Map();
    this.nextId = 1;
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      this.dispatchEvent(new CustomEvent("worker-error", { detail: event.message }));
    });
  }

  handleMessage(message) {
    if (message.event) {
      this.dispatchEvent(new CustomEvent(message.type, { detail: message }));
      return;
    }
    const resolver = this.pending.get(message.id);
    if (!resolver) return;
    this.pending.delete(message.id);
    if (message.ok) {
      delete message.ok;
      resolver.resolve(message);
    } else {
      const error = new Error(message.error);
      error.code = message.code;
      error.conflicts = message.conflicts;
      error.latest = message.latest;
      resolver.reject(error);
    }
  }

  request(payload) {
    const id = `${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...payload });
    });
  }

  init() {
    return this.request({ type: "init" }).then((result) => {
      this.tabId = result.tabId;
      return result;
    });
  }

  createTenant(id, name, parentId) {
    return this.request({ type: "createTenant", id, name, parentId: parentId || null });
  }

  saveRevision(tenantId, config, baseVersion, mode, message) {
    return this.request({ type: "saveRevision", tenantId, config, baseVersion, mode, message });
  }

  rollback(tenantId, targetVersion, message) {
    return this.request({ type: "rollback", tenantId, targetVersion, message });
  }
}
