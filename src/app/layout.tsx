import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "OperatorAgent · 智能运维",
  description: "Kubernetes Node 与 Pod 的 Prometheus 监控控制台",
};
/** 渲染整个应用共享的 HTML 文档和页面外框。
 * @param children 当前路由页面传入的 React 节点。
 * @returns 带 zh-CN 语言和全局样式的 HTML 根元素。
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
