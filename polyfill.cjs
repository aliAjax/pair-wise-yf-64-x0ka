// 环境兼容补丁：部分 Node 构建缺少 markAsUncloneable（undici 的 CacheStorage 依赖它）。
// 通过 NODE_OPTIONS=--require=./polyfill.cjs 在加载任何模块之前执行。
for (const mod of ['node:worker_threads', 'node:util']) {
  const m = require(mod);
  if (typeof m.markAsUncloneable !== 'function') {
    m.markAsUncloneable = () => {};
  }
}
