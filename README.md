# 配置中心（纯前端，无后端）

多租户配置中心演示：配置隔离、继承、覆盖、热更新、回滚、冲突检测。

## 技术栈

- **IndexedDB**：配置、租户、版本快照持久化（刷新不丢）
- **BroadcastChannel**：跨标签页 / 跨实例热更新广播
- **Web Worker**：合并计算、事务写入、冲突检测都在 Worker 中执行，不阻塞 UI

## 运行

ES Module + Worker 需要通过 HTTP 访问（不能用 file://）：

```bash
cd B
python3 -m http.server 8000
# 打开 http://localhost:8000/        演示页面
# 打开 http://localhost:8000/test.html  浏览器内验收测试

# 或无浏览器直接跑 Node 集成测试（shim 浏览器 API，驱动真实 worker/configCenter 代码）：
node test/node-test.mjs
```

## 架构

```
index.html / test.html
   └── js/configCenter.js   主线程 API（租户切换、订阅、BroadcastChannel 监听）
         └── js/worker.js   Web Worker（继承链合并、乐观锁写入、版本快照、回滚）
               ├── js/db.js     IndexedDB 封装（tenants / configs / versions）
               └── js/merge.js  深合并、路径读写、provenance 追踪
```

## 核心设计

- **隔离**：每个租户一份配置文档（`configs` store 按 tenantId 存取），切换租户只加载该租户及其继承链数据。
- **继承与覆盖**：租户有 `parentId`，链为 `global → group → tenant`，从根到叶深合并，叶子优先级最高；`provenance` 记录每个键的来源层。
- **热更新**：Worker 提交后通过 BroadcastChannel 广播 `config-changed`；其它标签页收到后，若变更租户在当前继承链上则自动重新拉取并刷新视图。
- **回滚**：每次写入在 `versions` store 生成不可变快照；回滚 = 把目标快照作为新版本写入（历史不被篡改）。
- **冲突检测**：乐观锁。写入携带 `baseVersion`，Worker 在同一事务内校验当前版本，不一致则返回 `{ conflict, currentVersion, currentData }`，写入不生效。
- **持久化**：全部状态在 IndexedDB；当前租户记忆在 localStorage，刷新后恢复。

## 验收标准对照

| 标准 | 实现 | 测试 |
|---|---|---|
| 租户覆盖生效 | 深合并叶子优先 + provenance | test 2 |
| 热更新即时 | BroadcastChannel 广播 → 自动 refresh | test 3 |
| 继承链正确 | parentId 链 + 环检测 | test 1 |
| 回滚正确 | 快照恢复为新版本 | test 4 |
| 冲突可检测 | baseVersion 乐观锁 | test 5 |
| 租户切换不串数据 | 按 tenantId 隔离存取 | test 6 |
| 刷新不丢配置 | IndexedDB 持久化 | test 7 |
