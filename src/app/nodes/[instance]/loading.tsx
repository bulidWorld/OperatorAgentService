/** 渲染 Node 详情路由加载数据期间的占位界面。
 * @returns 节点性能详情的加载状态 React 元素。
 */
export default function Loading() {
  return <main className="node-detail"><a className="detail-back" href="/?scope=nodes">← 返回Node监控</a><h1>节点性能详情</h1><div className="panel empty" role="status">正在加载节点 CPU、内存、磁盘与网络指标…</div></main>;
}
