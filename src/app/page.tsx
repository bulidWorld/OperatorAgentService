import Dashboard from "@/components/dashboard";
import { getDashboard } from "@/lib/prometheus/business";
import { isStepSelection, type StepSelection } from "@/lib/chart";
import { errorLog } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 服务端渲染监控首页，并按 URL 查询参数加载初始面板数据。
 * @param searchParams Next.js 提供的 scope、minutes、step 查询参数。
 * @returns 带初始数据的 Dashboard 客户端组件；加载失败时向组件传递错误。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[]; minutes?: string | string[]; step?: string | string[] }>;
}) {
  const params = await searchParams;
  const scope = params.scope === "pods" ? "pods" : "nodes";
  const rawMinutes = Number(params.minutes || 60);
  const minutes = [15, 60, 360, 1440].includes(rawMinutes) ? rawMinutes : 60;
  const rawStep = params.step || "auto";
  const step: StepSelection = rawStep === "auto" ? "auto" : isStepSelection(Number(rawStep)) ? Number(rawStep) as StepSelection : "auto";
  try {
    const data = await getDashboard(scope, minutes, step);
    return <Dashboard key={`${scope}-${minutes}-${step}`} initialScope={scope} initialMinutes={minutes} initialStep={step} initialData={data} />;
  } catch (error) {
    errorLog("dashboard.initial.failed", error);
    return <Dashboard key={`${scope}-${minutes}-${step}`} initialScope={scope} initialMinutes={minutes} initialStep={step} initialError={error instanceof Error ? error.message : "监控数据加载失败"} />;
  }
}
