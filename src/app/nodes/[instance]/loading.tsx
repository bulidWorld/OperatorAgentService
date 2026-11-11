export default function Loading() {
  return <main className="node-detail"><a className="detail-back" href="/?scope=nodes">← 返回Node监控</a><h1>节点性能详情</h1><div className="panel empty" role="status">正在加载节点 CPU、内存、磁盘与网络指标…</div></main>;
}
