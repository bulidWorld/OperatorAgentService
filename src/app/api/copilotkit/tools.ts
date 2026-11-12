import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import {
  getStoredAlertDetails,
  getStoredAlerts,
} from "@/lib/kubernetes-events";
import { getPodLogs } from "@/lib/kubernetes-logs";
import { queryKubernetesNetwork } from "@/lib/kubernetes-network";
import { runNetworkProbe } from "@/lib/network-probes";
import { restartPod } from "@/lib/kubernetes-restart";
import {
  query as queryPrometheus,
  queryRange as queryPrometheusRange,
} from "@/lib/prometheus/http";

/**
 * Agent 可调用的服务端工具集合。
 * 每个工具都在这里声明名称、输入校验和执行逻辑；需要副作用的操作必须在工具实现中做服务端校验。
 */
export const copilotTools = [
  /** 按条件遍历数据库分页，返回匹配的告警记录。 */
  defineTool({
    name: "query_alerts",
    description:
      "按条件查询告警，支持来源、类型、级别、对象和时间范围；可包含已恢复记录，结果自动分页。",
    parameters: z.object({
      source: z
        .enum(["alertmanager", "kubernetes"])
        .optional()
        .describe("告警来源；alertmanager 表示 Alertmanager 告警，kubernetes 表示 Kubernetes Event。"),
      alertType: z.string().optional().describe("告警类型或告警名，例如 PodNotReady、Warning。"),
      severity: z.string().optional().describe("告警级别，例如 critical、warning、info；按数据中记录的值匹配。"),
      from: z
        .iso.datetime()
        .optional()
        .describe("查询开始时间，ISO 8601 日期时间，必须包含时区，例如 2026-11-12T00:00:00Z。"),
      to: z
        .iso.datetime()
        .optional()
        .describe("查询结束时间，ISO 8601 日期时间，必须包含时区；应晚于 from。"),
      namespace: z.string().optional().describe("Kubernetes 命名空间；集群级对象或 Alertmanager 告警可不填。"),
      objectType: z.string().optional().describe("关联 Kubernetes 对象类型，例如 Pod、Node、Deployment。"),
      objectName: z.string().optional().describe("关联对象名称，例如 Pod 名称或 Node 名称。"),
      includeResolved: z
        .boolean()
        .optional()
        .describe("是否包含已恢复/已结束的告警记录；true 包含，false 或省略时仅查活动记录。"),
    }),
    execute: async ({
      source,
      alertType,
      severity,
      from,
      to,
      namespace,
      objectType,
      objectName,
      includeResolved,
    }) => {
      const alerts = [];
      let cursor: string | undefined;
      do {
        const page = await getStoredAlerts(500, cursor, {
          source,
          alertType,
          severity,
          from,
          to,
          namespace,
          objectType,
          objectName,
          includeResolved,
        });
        alerts.push(...page.alerts);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { total: alerts.length, alerts };
    },
  }),

  /** 执行模型生成的 PromQL，即时查询或受限时长/采样数的区间查询。 */
  defineTool({
    name: "query_promql",
    description:
      "使用 PromQL 查询 Prometheus 指标。适用于 CPU、内存、磁盘、网络、Pod/Node 状态等自定义指标查询。模型负责生成 PromQL；默认执行即时查询。需要趋势时设置 rangeMinutes 和 stepSeconds 执行区间查询。只读查询，不会修改监控数据。",
    parameters: z.object({
      promql: z.string().trim().min(1).max(4000),
      rangeMinutes: z.number().int().min(1).max(1440).optional(),
      stepSeconds: z.number().int().min(15).max(3600).optional(),
    }),
    execute: async ({ promql, rangeMinutes, stepSeconds }) => {
      if (rangeMinutes === undefined) {
        if (stepSeconds !== undefined)
          throw new Error("区间查询需要同时指定 rangeMinutes");
        return { mode: "instant", promql, ...(await queryPrometheus(promql)) };
      }
      const step = stepSeconds ?? 60;
      const end = Math.floor(Date.now() / 1000);
      const start = end - rangeMinutes * 60;
      const estimatedSamples = Math.ceil((end - start) / step);
      if (estimatedSamples > 3000)
        throw new Error("区间采样点过多，请缩短 rangeMinutes 或增大 stepSeconds");
      return {
        mode: "range",
        promql,
        rangeMinutes,
        stepSeconds: step,
        ...(await queryPrometheusRange(promql, start, end, step)),
      };
    },
  }),

  /** 按数据库 ID 返回单条告警详情，供 Agent 在诊断该告警时首先调用。 */
  defineTool({
    name: "query_alert_details",
    description:
      "根据告警数据库 ID 查询完整详情和当前恢复状态。对单条告警诊断时必须首先调用此工具。",
    parameters: z.object({ id: z.number().int().positive() }),
    execute: async ({ id }) => {
      const details = await getStoredAlertDetails(id);
      return details
        ? { found: true, ...details }
        : { found: false, id, message: "未找到该告警记录" };
    },
  }),

  /** 读取指定 Pod 容器的近期日志。 */
  defineTool({
    name: "query_pod_logs",
    description: "读取指定 Kubernetes Pod 容器的近期日志，用于故障分析。",
    parameters: z.object({
      namespace: z.string().min(1),
      pod: z.string().min(1),
      container: z.string().optional(),
      sinceMinutes: z.number().int().min(1).max(10080).optional(),
      tailLines: z.number().int().min(1).max(5000).optional(),
    }),
    execute: async (args) => getPodLogs(args),
  }),

  /** 查询 Kubernetes Service 路由、EndpointSlice、NetworkPolicy、Pod 和 Node 状态。 */
  defineTool({
    name: "query_k8s_network",
    description:
      "查询 Kubernetes Service、EndpointSlice、NetworkPolicy、Pod 与 Node 网络配置和状态。网络类故障应调用此工具。",
    parameters: z.object({
      namespace: z.string().optional(),
      service: z.string().optional(),
    }),
    execute: async (args) => queryKubernetesNetwork(args),
  }),

  /** 从当前 OperatorAgentService Pod 发起网络探测，不执行模型提供的 shell 命令。 */
  defineTool({
    name: "check_network_connectivity",
    description:
      "从 OperatorAgentService Pod 主动检测目标的 ICMP、TCP 端口或 HTTP(S) 连通性。命令和参数来自服务端配置白名单，不执行 shell。只代表本服务 Pod 的网络视角。",
    parameters: z.object({
      type: z.enum(["icmp", "tcp", "http"]),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
      url: z.string().url().optional(),
    }),
    execute: async (args) => runNetworkProbe(args),
  }),

  /** 产生 CopilotKit interrupt；本工具不执行删除，等待用户审批后由 Agent 继续。 */
  defineTool({
    name: "request_pod_restart_approval",
    description:
      "申请重启指定 Kubernetes Pod 的人工审批。此工具会暂停运行，必须等待用户批准或拒绝。",
    parameters: z.object({
      namespace: z.string().min(1),
      pod: z.string().min(1),
      reason: z.string().min(1).max(500),
    }),
    interrupt: true,
    interruptReason: "tool_call",
    interruptMessage:
      "该操作会删除目标 Pod 并触发重建。请核对 namespace、Pod 和原因后批准或拒绝。",
  }),

  /** 执行已审批的 Pod 重启，并记录审批操作审计日志。 */
  defineTool({
    name: "restart_pod",
    description:
      "仅在用户刚刚明确批准 request_pod_restart_approval 后执行 Pod 重启。未经批准不得调用。",
    parameters: z.object({
      namespace: z.string().min(1),
      pod: z.string().min(1),
      reason: z.string().min(1).max(500),
      approved: z.literal(true),
    }),
    execute: async ({ namespace, pod, reason, approved }) => {
      if (approved !== true) throw new Error("没有有效的人工审批");
      console.info(
        JSON.stringify({
          event: "kubernetes.pod.restart.approved",
          namespace,
          pod,
          reason,
          approvedAt: new Date().toISOString(),
        }),
      );
      return restartPod({ namespace, pod });
    },
  }),
];
