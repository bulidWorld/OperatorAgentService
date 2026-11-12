"use client";

import { CopilotChat, useAgent } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";

function DiagnosticChat({ alertId }: { alertId: number }) {
  const threadId = `alert-diagnostic-${alertId}`;
  const agentId = `diagnostic-${alertId}`;
  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: "default",
    threadId,
  });
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

  return (
    <CopilotChat
      agentId={agentId}
      threadId={threadId}
      labels={{ chatInputPlaceholder: "补充信息或继续追问…" }}
    />
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
      className="alert-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="alert-modal diagnostic-modal"
        role="dialog"
        aria-modal="true"
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
