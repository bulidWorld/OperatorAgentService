"use client";

import { useEffect, useMemo, useState } from "react";
import { CopilotChat, useAgent, useInterrupt } from "@copilotkit/react-core/v2";
import type { ActivityMessage, Interrupt } from "@ag-ui/client";
import { Activity, Bot, Check, CircleAlert, Clock3, FileText, LoaderCircle, ShieldCheck, Wrench, X } from "lucide-react";
import type {
  ApprovalInput,
  ApprovalRequest,
} from "@/lib/approval";
import { parseApprovalRequest, validateApprovalAnswers } from "@/lib/approval";
import { parseAgentRunActivity, reduceActivityDelta, reduceActivitySnapshot, type AgentRunEvent, type AgentRunActivity, type ActivitySyncState } from "@/lib/activity";

function useAgentActivity(agent: ReturnType<typeof useAgent>["agent"], isReady: boolean) {
  const [activity, setActivity] = useState<ActivityMessage | null>(null);
  const [sync, setSync] = useState<ActivitySyncState>("ready");

  useEffect(() => {
    if (!isReady) return;
    const subscription = agent.subscribe({
      onActivitySnapshotEvent: ({ event }) => {
        const result = reduceActivitySnapshot(null, event);
        if (event.activityType === "agent_run") {
          setActivity(result.activity);
          setSync(result.sync);
        }
      },
      onActivityDeltaEvent: ({ event }) => {
        if (event.activityType !== "agent_run") return;
        setActivity((current) => {
          const result = reduceActivityDelta(current, event, sync);
          setSync(result.sync);
          return result.activity;
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, isReady, sync]);

  return { activity: parseAgentRunActivity(activity?.content), sync };
}

const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  awaiting_approval: "等待审批",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

const eventTypeLabels: Record<string, string> = {
  model_inference: "模型分析",
  tool_execution: "工具执行",
  system_step: "系统步骤",
  approval: "人工审批",
};

function StatusIcon({ status, type }: { status: string; type: string }) {
  if (status === "running") return <LoaderCircle className="activity-status-icon is-spinning" size={16} />;
  if (status === "awaiting_approval") return <ShieldCheck className="activity-status-icon" size={16} />;
  if (status === "failed") return <CircleAlert className="activity-status-icon" size={16} />;
  if (status === "cancelled") return <X className="activity-status-icon" size={16} />;
  if (status === "completed") return <Check className="activity-status-icon" size={16} />;
  if (type === "tool_execution") return <Wrench className="activity-status-icon" size={16} />;
  if (type === "approval") return <ShieldCheck className="activity-status-icon" size={16} />;
  if (type === "model_inference") return <Bot className="activity-status-icon" size={16} />;
  return <Activity className="activity-status-icon" size={16} />;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function EventDetails({ item }: { item: AgentRunEvent }) {
  const details: Array<[string, unknown]> = [];
  if (item.input && Object.keys(item.input).length) details.push(["输入摘要", item.input]);
  if (item.output?.text) details.push(["回复", item.output.text]);
  if (item.output?.structuredContent) details.push(["结构化结果", item.output.structuredContent]);
  if (item.output?.content?.length) details.push(["结果内容", item.output.content]);
  if (item.output?.resources?.length) details.push(["资源", item.output.resources]);
  if (item.error) details.push(["错误摘要", item.error]);
  if (!details.length) return null;
  return <details className="activity-event-details"><summary>查看执行详情</summary><div>{details.map(([label, value]) => <section key={label}><b>{label}</b><pre>{displayValue(value)}</pre></section>)}</div></details>;
}

function ActivityTimeline({ activity, sync }: { activity: AgentRunActivity | null; sync: ActivitySyncState }) {
  if (!activity) {
    return <section className="activity-timeline activity-timeline-empty"><div className="activity-timeline-heading"><div><span className="activity-kicker">LIVE EXECUTION</span><h3>执行时间线</h3></div><span className="activity-live-indicator">等待任务</span></div><div className="activity-empty-state"><span><Clock3 size={18} /></span><p>发起一次故障分析后，模型与工具的执行过程会显示在这里。</p></div></section>;
  }
  const sortedEvents = [...activity.events].sort((a, b) => a.sequence - b.sequence);
  const runStatus = statusLabels[activity.run.status] ?? activity.run.status;
  return (
    <section className="activity-timeline" aria-live="polite">
      <div className="activity-timeline-heading">
        <div><span className="activity-kicker">LIVE EXECUTION</span><h3>执行时间线 <span className="activity-event-count">{sortedEvents.length} 步</span></h3></div>
        <span className={`activity-run-status status-${activity.run.status}`}><i />{runStatus}</span>
      </div>
      {sync === "needs_snapshot" && <div className="activity-sync-notice"><FileText size={14} />活动增量暂不可用，等待完整快照同步。</div>}
      <div className="activity-run-meta"><span><b>Run</b><code>{activity.run.runId}</code></span><span><b>开始于</b>{formatActivityTime(activity.run.startedAt)}</span></div>
      {activity.run.error && <p className="activity-run-error">{activity.run.error}</p>}
      {sortedEvents.length === 0 ? <div className="activity-empty-state compact"><span><Activity size={17} /></span><p>任务已启动，正在等待第一个执行步骤…</p></div> : (
        <ol className="activity-event-list">
          {sortedEvents.map((item, index) => (
            <li key={item.id} className={`activity-event status-${item.status}`} style={{ "--event-index": index } as React.CSSProperties}>
              <div className="activity-event-rail"><span className="activity-event-marker"><StatusIcon status={item.status} type={item.type} /></span>{index < sortedEvents.length - 1 && <i />}</div>
              <article className="activity-event-card">
                <div className="activity-event-topline"><span className="activity-event-type">{eventTypeLabels[item.type] ?? "执行步骤"}</span><time>{formatActivityTime(item.startedAt)}</time></div>
                <div className="activity-event-title-row"><h4>{item.title}</h4><span className={`activity-event-status status-${item.status}`}>{statusLabels[item.status] ?? item.status}</span></div>
                {item.tool && <p className="activity-tool-label"><Wrench size={12} />{item.tool.name}{item.tool.server ? <span>· {item.tool.server}</span> : null}</p>}
                {item.approval?.requestId && <p className="activity-approval-ref">审批单 <code>{item.approval.requestId}</code></p>}
                <EventDetails item={item} />
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function readRequest(interrupt: Interrupt): ApprovalRequest | null {
  const metadata = interrupt.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return parseApprovalRequest((metadata as Record<string, unknown>).approvalRequest);
}

function ApprovalField({
  input,
  value,
  onChange,
}: {
  input: ApprovalInput;
  value: boolean | string | string[] | undefined;
  onChange: (value: boolean | string | string[]) => void;
}) {
  if (input.type === "confirm") {
    return (
      <fieldset className="approval-field">
        <legend>{input.label}{input.required ? " *" : ""}</legend>
        <label><input type="radio" name={`approval-${input.key}`} checked={value === true} onChange={() => onChange(true)} /> 是</label>
        <label><input type="radio" name={`approval-${input.key}`} checked={value === false} onChange={() => onChange(false)} /> 否</label>
      </fieldset>
    );
  }
  if (input.type === "single_select") {
    return (
      <label className="approval-field">
        <span>{input.label}{input.required ? " *" : ""}</span>
        <select value={typeof value === "string" ? value : ""} required={input.required} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled={input.required}>{input.placeholder ?? "请选择"}</option>
          {input.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
  }
  if (input.type === "multi_select") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="approval-field">
        <legend>{input.label}{input.required ? " *" : ""}</legend>
        {input.options?.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <label className="approval-field">
      <span>{input.label}{input.required ? " *" : ""}</span>
      <textarea
        value={typeof value === "string" ? value : ""}
        placeholder={input.placeholder}
        maxLength={input.max_length}
        required={input.required}
        onChange={(event) => onChange(event.target.value)}
      />
      {input.max_length !== undefined && <small>{typeof value === "string" ? value.length : 0}/{input.max_length}</small>}
    </label>
  );
}

function ApprovalCard({
  request,
  interruptId,
  message,
  resolve,
  cancel,
}: {
  request: ApprovalRequest | null;
  interruptId: string;
  message?: string;
  resolve: (value: unknown, id?: string) => unknown;
  cancel: (id?: string) => unknown;
}) {
  const [answers, setAnswers] = useState<Record<string, boolean | string | string[]>>({});
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");

  if (!request) {
    return (
      <div className="pod-restart-approval" role="alertdialog">
        <strong>无法读取审批请求</strong>
        <p>请求结构缺失或版本不受支持，不能提交审批。</p>
        <div><button type="button" className="button secondary" onClick={() => void cancel(interruptId)}>关闭</button></div>
      </div>
    );
  }

  const decide = (status: "approved" | "rejected") => {
    const validationError = validateApprovalAnswers(request, answers);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    void resolve({
      request_id: request.request_id,
      status,
      answers,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    }, interruptId);
  };

  return (
    <div className="pod-restart-approval" role="alertdialog" aria-labelledby={`approval-title-${interruptId}`}>
      <strong id={`approval-title-${interruptId}`}>需要人工审批：{request.title}</strong>
      {message && <p>{message}</p>}
      <p><b>动作：</b>{request.action}</p>
      <p><b>判断原因：</b>{request.rationale}</p>
      <p><b>拟议方案及影响范围：</b>{request.change_plan}</p>
      {request.evidence.length > 0 && (
        <div className="approval-evidence">
          <b>证据</b>
          {request.evidence.map((item, index) => (
            <p key={`${item.kind}-${index}`}><b>{item.kind} · {item.source}：</b>{item.summary}{item.timestamp && <>（{item.timestamp}）</>}{item.url && <> <a href={item.url} target="_blank" rel="noreferrer">查看</a></>}</p>
          ))}
        </div>
      )}
      <div className="approval-fields">
        {request.inputs.map((input) => (
          <ApprovalField
            key={input.key}
            input={input}
            value={answers[input.key]}
            onChange={(value) => setAnswers((current) => ({ ...current, [input.key]: value }))}
          />
        ))}
      </div>
      <label className="approval-field">
        <span>总体审核意见（可选）</span>
        <textarea value={comment} placeholder="填写总体意见" onChange={(event) => setComment(event.target.value)} />
      </label>
      {error && <p role="alert" className="approval-error">{error}</p>}
      <div>
        <button type="button" className="button secondary" onClick={() => decide("rejected")}>拒绝</button>
        <button type="button" className="button danger" onClick={() => decide("approved")}>批准并继续</button>
      </div>
    </div>
  );
}

export default function FaultAgent() {
  const { agent, isReady } = useAgent();
  const { activity, sync } = useAgentActivity(agent, isReady);
  const approval = useInterrupt({
    renderInChat: false,
    enabled: ({ name }) => name === "on_interrupt",
    render: ({ interrupt, interrupts, resolve, cancel }) => {
      const pending = interrupts.length ? interrupts : interrupt ? [interrupt] : [];
      return (
        <div className="pod-restart-approvals" aria-live="polite">
          {pending.map((item) => {
            const request = readRequest(item);
            return (
              <ApprovalCard
                key={item.id}
                request={request}
                interruptId={item.id}
                message={item.message}
                resolve={resolve}
                cancel={cancel}
              />
            );
          })}
        </div>
      );
    },
  });

  return (
    <section className="panel fault-agent">
      <div className="panel-heading">
        <div className="list-title">
          <h2>故障分析 Agent</h2>
          <span className="count-pill">自然语言查询</span>
        </div>
      </div>
      <p>可查询活动告警、读取 Pod 日志并结合上下文分析故障原因。</p>
      <ActivityTimeline activity={activity} sync={sync} />
      <CopilotChat labels={{ chatInputPlaceholder: "例如：production/payment-api 最近有哪些故障？" }} />
      {approval}
    </section>
  );
}
