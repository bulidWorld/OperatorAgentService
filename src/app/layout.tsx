import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "KubeScope · 集群监控",
  description: "Kubernetes Node 与 Pod 的 Prometheus 监控控制台",
};
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
