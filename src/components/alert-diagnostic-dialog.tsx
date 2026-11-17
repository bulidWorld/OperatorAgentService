"use client";

import { CopilotChat, useAgent } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, RotateCcw, Wrench, X } from "lucide-react";

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

type DiagnosticRunError = {
  code?: string;
  message: string;
};

function toDiagnosticRunError(value: unknown): DiagnosticRunError {
  const objects: Record<string, unknown>[] = [];
  let current = value;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") break;
    const object = current as Record<string, unknown>;
    objects.push(object);
    current = object.error ?? object.cause ?? object.data;
  }
  const code = objects.find((object) => typeof object.code === "string")?.code as string | undefined;
  if (code === "INCOMPLETE_STREAM")
    return {
      code,
      message: "连接提前中断，诊断结果可能不完整。请重试继续诊断。",
    };
  return {
    code,
    message: "诊断暂时失败，请稍后重试。",
  };
}

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
  const [runError, setRunError] = useState<DiagnosticRunError>();

  const runAgent = useCallback(() => {
    setRunError(undefined);
    void agent.runAgent().catch((error: unknown) => {
      setRunError(toDiagnosticRunError(error));
    });
  }, [agent]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: () => setRunError(undefined),
      onRunErrorEvent: ({ event }) =>
        setRunError(toDiagnosticRunError(event)),
      onRunFailed: ({ error }) =>
        setRunError(toDiagnosticRunError(error)),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  useEffect(() => {
    if (!isReady || started.current) return;
    started.current = true;
    agent.addMessage({
      id: `diagnose-${alertId}`,
      role: "user",
      content: `请诊断告警 ID ${alertId}。`,
    });
    runAgent();
  }, [agent, alertId, isReady, runAgent]);

  if (!isReady) return null;

  return (
    <div className="diagnostic-chat-content">
      <ToolActivity messages={chatMessages} isRunning={agent.isRunning} />
      {runError && (
        <div className="diagnostic-run-error" role="alert">
          <AlertTriangle size={16} />
          <span>{runError.message}</span>
          <button type="button" onClick={runAgent} disabled={agent.isRunning}>
            <RotateCcw size={14} />
            重试
          </button>
        </div>
      )}
      <CopilotChat
        agentId={agentId}
        threadId={threadId}
        chatView={{ className: "diagnostic-chat-view" }}
        labels={{ chatInputPlaceholder: "补充信息或继续追问…" }}
      />
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
