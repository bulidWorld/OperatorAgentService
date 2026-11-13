"use client";

import { CopilotChat, useAgent } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useRef } from "react";
import { Check, LoaderCircle, Wrench, X } from "lucide-react";

type ToolCall = {
  id: string;
  function?: { name?: string; arguments?: unknown };
};

type ChatMessage = {
  role?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  content?: unknown;
};

function formatToolValue(value: unknown, limit = 1800) {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…` : value;
  if (value === undefined || value === null) return "";
  let formatted: string;
  try {
    formatted = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    formatted = String(value);
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}…` : formatted;
}

const toolLabels: Record<string, string> = {
  query_alert_details: "查询告警详情",
  query_alerts: "查询相关告警",
  query_promql: "查询监控指标",
  query_pod_logs: "读取 Pod 日志",
  query_k8s_network: "检查 Kubernetes 网络状态",
  check_network_connectivity: "探测网络连通性",
  request_pod_restart_approval: "申请重启 Pod 审批",
};

function ToolActivity({ messages, isRunning }: { messages: ChatMessage[]; isRunning: boolean }) {
  const calls = new Map<string, ToolCall>();
  const results = new Map<string, unknown>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    } else if (message.role === "tool" && message.toolCallId) {
      results.set(message.toolCallId, message.content);
    }
  }

  if (!calls.size) return null;

  return (
    <section className="diagnostic-tool-activity" aria-label="工具调用记录" aria-live="polite">
      <div className="diagnostic-tool-heading"><Wrench size={14} /> 工具调用 <span>{calls.size}</span></div>
      <div className="diagnostic-tool-list">
        {[...calls.values()].map((call) => {
          const result = results.get(call.id);
          const complete = results.has(call.id);
          const name = call.function?.name ?? "未知工具";
          const args = formatToolValue(call.function?.arguments);
          const output = formatToolValue(result, 3000);
          return (
            <details className="diagnostic-tool-card" key={call.id}>
              <summary>
                {complete ? <Check size={14} /> : <LoaderCircle className={isRunning ? "diagnostic-tool-spin" : ""} size={14} />}
                <strong>{toolLabels[name] ?? name}</strong>
                <span className={complete ? "diagnostic-tool-done" : "diagnostic-tool-running"}>{complete ? "已完成" : isRunning ? "执行中" : "等待结果"}</span>
              </summary>
              {args && <div className="diagnostic-tool-detail"><b>参数</b><pre>{args}</pre></div>}
              {complete && output && <div className="diagnostic-tool-detail"><b>结果</b><pre>{output}</pre></div>}
            </details>
          );
        })}
      </div>
    </section>
  );
}

function DiagnosticChat({ alertId }: { alertId: number }) {
  const threadId = `alert-diagnostic-${alertId}`;
  const agentId = `diagnostic-${alertId}`;
  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: "default",
    threadId,
  });
  const chatMessages = (agent.messages ?? []) as ChatMessage[];
  const started = useRef(false);

  useEffect(() => {
    if (!isReady || started.current) return;
    started.current = true;
    agent.addMessage({
      id: `diagnose-${alertId}`,
      role: "user",
      content: `请诊断告警 ID ${alertId}。必须先调用 query_alert_details，参数 id=${alertId}，检查 resolutionStatus 和 resolvedAt。若仍 active，结合告警详情、同对象相关告警和需要时的 Pod 日志分析当前故障；若已 resolved，使用 occurredAt 到 resolvedAt 作为时间范围，并按 namespace、objectType、objectName 查询相关告警（includeResolved=true），追溯恢复前的原因。只要告警或描述涉及网络不通、连接超时、Service 无后端等网络问题，就调用 query_k8s_network，优先使用告警中的 namespace 和 Service 名称；目标 host/port 明确时，再调用 check_network_connectivity。只有拿到工具证据后再给结论，清楚区分证据、推测和建议。`,
    });
    void agent.runAgent();
  }, [agent, alertId, isReady]);

  if (!isReady) return null;

  return (
    <div className="diagnostic-chat-content">
      <CopilotChat
        agentId={agentId}
        threadId={threadId}
        labels={{ chatInputPlaceholder: "补充信息或继续追问…" }}
      />
      <ToolActivity messages={chatMessages} isRunning={agent.isRunning} />
    </div>
  );
}

export default function AlertDiagnosticDialog({
  alertId,
  onClose,
}: {
  alertId: number;
  onClose: () => void;
}) {
  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div
      className="alert-modal-backdrop diagnostic-drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="alert-modal diagnostic-modal"
        role="dialog"
        aria-modal="false"
        aria-labelledby="diagnostic-title"
      >
        <div className="alert-modal-heading">
          <div>
            <span className="eyebrow">FAULT DIAGNOSIS · ALERT #{alertId}</span>
            <h2 id="diagnostic-title">告警诊断</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <div className="diagnostic-copilot-chat">
          <DiagnosticChat key={alertId} alertId={alertId} />
        </div>
      </section>
    </div>
  );
}
