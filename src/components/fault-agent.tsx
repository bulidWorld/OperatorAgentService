"use client";

import { createContext, useContext, useEffect, useId, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { CopilotChat, CopilotChatView, useAgent, useInterrupt } from "@copilotkit/react-core/v2";
import { Markdown } from "@copilotkit/react-ui";
import { buildFaultAgentTurns } from "@/lib/fault-agent-turns";
import type { ActivityMessage, Interrupt } from "@ag-ui/client";
import { Activity, Bot, Check, CircleAlert, Clock3, FileText, History, LoaderCircle, ShieldCheck, Wrench, X } from "lucide-react";
import type {
  ApprovalInput,
  ApprovalRequest,
} from "@/lib/approval";
import { parseApprovalRequest, validateApprovalDecision } from "@/lib/approval";
import { isStepOutput, parseAgentRunActivity, reduceActivityDelta, reduceActivitySnapshot, type AgentRunEvent, type AgentRunActivity, type ActivitySyncState } from "@/lib/activity";
import { useRef } from "react";
import { appendMessageText, storeToolResult } from "@/lib/activity-details";

/**
 * 管理AgentActivity相关状态和副作用。
 * @param agent agent 参数。
 * @param isReady isReady 参数。
 * @returns 执行结果。
 */
function useAgentActivity(agent: ReturnType<typeof useAgent>["agent"], isReady: boolean) {
  const [runUsers, setRunUsers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [failedRuns, setFailedRuns] = useState<Record<string, boolean>>({});
  const [activities, setActivities] = useState<Record<string, { activity: AgentRunActivity; sync: ActivitySyncState }>>({});
  const [toolResults, setToolResults] = useState<Record<string, unknown>>({});
  const [messageText, setMessageText] = useState<Record<string, string>>({});
  const messageTextCache = useRef<Record<string, string>>({});
  const activeRunId = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    const snapshots = new Map<string, { activity: ActivityMessage | null; sync: ActivitySyncState }>();
    setActivities({});
    setRunUsers({});
    setResults({});
    setFailedRuns({});
    setToolResults({});
    setMessageText({});
    messageTextCache.current = {};
    activeRunId.current = null;
        /**
 * 执行 save 相关处理。
 * @param message message 参数。
 * @param sync sync 参数。
 * @returns 执行结果。
 */
        const save = (message: ActivityMessage | null, sync: ActivitySyncState) => {
      const parsed = parseAgentRunActivity(message?.content);
      if (parsed) setActivities((current) => ({ ...current, [parsed.run.runId]: { activity: parsed, sync } }));
    };
        /**
 * 执行 hydrate 相关处理。
 * @param messages messages 参数。
 * @returns 执行结果。
 */
        const hydrate = (messages: typeof agent.messages) => {
      let userId: string | undefined;
      for (const message of messages) {
        if (message.role === "user") userId = message.id;
        if (message.role !== "activity") continue;
        const parsed = parseAgentRunActivity(message.content);
        if (!parsed) continue;
        snapshots.set(message.id, { activity: message, sync: "ready" });
        if (userId) {
          const owner = userId;
          setRunUsers((current) => ({ ...current, [parsed.run.runId]: owner }));
        }
        save(message, "ready");
      }
    };
    hydrate(agent.messages);
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ event, messages }) => {
        activeRunId.current = event.runId;
        const user = [...messages].reverse().find((message) => message.role === "user");
        if (user) setRunUsers((current) => ({ ...current, [event.runId]: user.id }));
      },
      onRunFinishedEvent: ({ event }) => {
        if (typeof event.result === "string" && event.result.trim()) {
          const text = event.result;
          setResults((current) => ({ ...current, [event.runId]: text }));
        }
      },
      onRunErrorEvent: () => {
        const runId = activeRunId.current;
        if (runId) setFailedRuns((current) => ({ ...current, [runId]: true }));
      },
      onMessagesSnapshotEvent: ({ event }) => hydrate(event.messages),
      onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
        const messages = appendMessageText(messageTextCache.current, event.messageId, event.delta);
        const currentBuffer = textMessageBuffer || messages[event.messageId];
        messageTextCache.current = { ...messages, [event.messageId]: currentBuffer };
        setMessageText((current) => ({ ...current, [event.messageId]: currentBuffer }));
      },
      onToolCallResultEvent: ({ event }) => {
        setToolResults((current) => storeToolResult(current, event.toolCallId, event.content));
      },
      onActivitySnapshotEvent: ({ event }) => {
        if (event.activityType !== "agent_run") return;
        const previous = snapshots.get(event.messageId);
        const result = reduceActivitySnapshot(previous?.activity ?? null, event, previous?.sync ?? "ready");
        snapshots.set(event.messageId, result);
        save(result.activity, result.sync);
      },
      onActivityDeltaEvent: ({ event }) => {
        if (event.activityType !== "agent_run") return;
        const previous = snapshots.get(event.messageId);
        const result = reduceActivityDelta(previous?.activity ?? null, event, previous?.sync ?? "ready");
        snapshots.set(event.messageId, result);
        save(result.activity, result.sync);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, isReady, agent.threadId]);

  return { activities, runUsers, results, failedRuns, toolResults, messageText };
}

const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  awaiting_approval: "等待审批",
  awaiting_input: "等待补充信息",
  awaiting_auth: "等待授权",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  rejected: "已拒绝",
};

const eventTypeLabels: Record<string, string> = {
  mode_selection: "模式选择",
  model_inference: "模型分析",
  reasoning: "推理",
  model_summary: "模型总结",
  tool_execution: "工具执行",
  a2a_task: "远端任务",
  system_step: "系统步骤",
  approval: "人工审批",
};

/**
 * 执行 StatusIcon 相关处理。
 * @param { status, type } { status, type } 参数。
 * @returns 执行结果。
 */
function StatusIcon({ status, type }: { status: string; type: string }) {
  if (status === "running") return <LoaderCircle className="activity-status-icon is-spinning" size={16} />;
  if (status === "awaiting_approval") return <ShieldCheck className="activity-status-icon" size={16} />;
  if (status === "failed") return <CircleAlert className="activity-status-icon" size={16} />;
  if (status === "cancelled") return <X className="activity-status-icon" size={16} />;
  if (status === "completed") return <Check className="activity-status-icon" size={16} />;
  if (type === "tool_execution") return <Wrench className="activity-status-icon" size={16} />;
  if (type === "approval") return <ShieldCheck className="activity-status-icon" size={16} />;
  if (type === "model_inference" || type === "reasoning" || type === "model_summary") return <Bot className="activity-status-icon" size={16} />;
  return <Activity className="activity-status-icon" size={16} />;
}

/**
 * 执行 displayValue 相关处理。
 * @param value value 参数。
 * @returns 执行结果。
 */
function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/**
 * 执行 EventDetails 相关处理。
 * @param { item, content, onOpen } { item, content, onOpen } 参数。
 * @returns 执行结果。
 */
function EventDetails({ item, content, onOpen }: { item: AgentRunEvent; content?: unknown; onOpen: (title: string, content: unknown) => void }) {
  if ((item.type === "reasoning" || item.type === "model_summary") && isStepOutput(item.output) && item.output.messages.length) {
    const messages = item.output.messages.map(({ type, text }) => `${type === "reasoning" ? "推理摘要" : "助手回复"}\n${text}`);
    return <button type="button" className="activity-event-details-button" onClick={() => onOpen(item.title, messages.join("\n\n"))}>查看详细内容</button>;
  }
  if (item.type === "a2a_task" && item.output) {
    const progress = item.output as { taskId?: string; status?: { state?: unknown; message?: unknown }; update?: unknown };
    const state = progress.status?.state;
    const stateLabel = typeof state === "number"
      ? ["未指定", "已提交", "执行中", "已完成", "执行失败", "已取消", "等待输入", "已拒绝", "等待授权"][state] ?? String(state)
      : typeof state === "string" ? state.replace("TASK_STATE_", "").toLowerCase().replaceAll("_", " ") : "状态未知";
    const update = progress.update as Record<string, unknown> | undefined;
    const message = update?.message ?? progress.status?.message;
    const artifact = update?.artifact;
    return <div className="activity-a2a-summary">
      <p>远端任务：{stateLabel}{progress.taskId ? <> · <code>{progress.taskId}</code></> : null}</p>
      {message !== undefined && <button type="button" className="activity-event-details-button" onClick={() => onOpen("远端任务消息", message)}>查看任务消息</button>}
      {artifact !== undefined && <button type="button" className="activity-event-details-button" onClick={() => onOpen("任务产物", artifact)}>查看任务产物</button>}
      {!message && !artifact && <button type="button" className="activity-event-details-button" onClick={() => onOpen("远端任务详情", item.output)}>查看任务详情</button>}
    </div>;
  }
  const details: Array<[string, unknown]> = [];
  const output = item.output as Record<string, unknown> | null | undefined;
  if (item.input && Object.keys(item.input).length) details.push(["输入摘要", item.input]);
  if (output?.text) details.push(["回复", output.text]);
  if (output?.structuredContent) details.push(["结构化结果", output.structuredContent]);
  if (Array.isArray(output?.content) && output.content.length) details.push(["结果内容", output.content]);
  if (Array.isArray(output?.resources) && output.resources.length) details.push(["资源", output.resources]);
  if (item.type === "reasoning" && Array.isArray(output?.summary) && output.summary.length) details.push(["推理摘要", output.summary]);
  if (item.error) details.push(["错误摘要", item.error]);
  if (content !== undefined) details.splice(0, details.length, [item.type === "tool_execution" ? "工具调用结果" : "模型回复", content]);
  if (!details.length) return null;
  return <button type="button" className="activity-event-details-button" onClick={() => onOpen(details[0][0], details[0][1])}>查看详细内容</button>;
}

/**
 * 执行 ActivityTimeline 相关处理。
 * @param { activity, sync, expanded, onExpandedChange, toolResults, messageText, recentEvents } { activity, sync, expanded, onExpandedChange, toolResults, messageText, recentEvents } 参数。
 * @returns 执行结果。
 */
function ActivityTimeline({ activity, sync, expanded, onExpandedChange, toolResults, messageText, recentEvents }: { activity: AgentRunActivity | null; sync: ActivitySyncState; expanded: boolean; onExpandedChange: (expanded: boolean) => void; toolResults: Record<string, unknown>; messageText: Record<string, string>; recentEvents?: ReadonlySet<AgentRunEvent> }) {
  const openApproval = useContext(ApprovalContext);
  const detailTitleId = useId();
  const [detail, setDetail] = useState<{ title: string; content: unknown } | null>(null);
  if (!activity) {
    return <div className="activity-empty-state compact"><span><Clock3 size={17} /></span><p>执行时间线暂不可用。</p></div>;
  }
  const sortedEvents = [...activity.events].sort((a, b) => a.sequence - b.sequence);
  const visibleEvents = recentEvents ? sortedEvents.filter((event) => recentEvents.has(event)) : sortedEvents;
  const runStatus = statusLabels[activity.run.status] ?? activity.run.status;
  return (
    <section className="activity-timeline" aria-live="polite">
      <details className="activity-timeline-fold" open={expanded} onToggle={(event) => { if (event.currentTarget.open !== expanded) onExpandedChange(event.currentTarget.open); }}>
      <summary className="activity-timeline-heading">
        <div><time className="activity-kicker" dateTime={activity.run.startedAt}>{recentEvents ? formatActivityTime(activity.run.startedAt) : new Date(activity.run.startedAt).toLocaleString("zh-CN", { hour12: false })}</time><h3>执行时间线 <span className="activity-event-count">{visibleEvents.length}{recentEvents !== undefined && visibleEvents.length < sortedEvents.length ? ` / ${sortedEvents.length}` : ""} 步</span></h3></div>
        <span className={`activity-run-status status-${activity.run.status}`}><i />{runStatus}</span>
      </summary>
      {sync === "needs_snapshot" && <div className="activity-sync-notice"><FileText size={14} />活动增量暂不可用，等待完整快照同步。</div>}
      <div className="activity-run-meta"><span><b>Run</b><code>{activity.run.runId}</code></span><span><b>开始于</b>{formatActivityTime(activity.run.startedAt)}</span></div>
      {activity.run.error && <p className="activity-run-error">{activity.run.error}</p>}
      {sortedEvents.length === 0 ? <div className="activity-empty-state compact"><span><Activity size={17} /></span><p>任务已启动，正在等待第一个执行步骤…</p></div> : (
        <ol className="activity-event-list">
          {visibleEvents.map((item, index) => (
            <li key={item.id} className={`activity-event status-${item.status}`}>
              <div className="activity-event-rail"><span className="activity-event-marker"><StatusIcon status={item.status} type={item.type} /></span>{index < visibleEvents.length - 1 && <i />}</div>
              <article className={`activity-event-card${item.status === "awaiting_approval" && item.type === "tool_execution" ? " is-approval-action" : ""}`} onClick={item.status === "awaiting_approval" && item.type === "tool_execution" ? () => openApproval(item) : undefined} onKeyDown={item.status === "awaiting_approval" && item.type === "tool_execution" ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openApproval(item); } } : undefined} role={item.status === "awaiting_approval" && item.type === "tool_execution" ? "button" : undefined} tabIndex={item.status === "awaiting_approval" && item.type === "tool_execution" ? 0 : undefined}>
                <div className="activity-event-topline"><span className="activity-event-type">{eventTypeLabels[item.type] ?? "执行步骤"}</span><time>{formatActivityTime(item.startedAt)}</time></div>
                <div className="activity-event-title-row"><h4>{item.title}</h4><span className={`activity-event-status status-${item.status}`}>{statusLabels[item.status] ?? item.status}</span></div>
                {item.tool && <p className="activity-tool-label"><Wrench size={12} />{item.tool.name}{item.tool.server ? <span>· {item.tool.server}</span> : null}</p>}
                {item.type === "approval" && item.approval && <p className="activity-approval-ref"><ShieldCheck size={12} />{item.approval.requestId ? <>审批单 <code>{item.approval.requestId}</code></> : "需要人工审批"}</p>}
                {item.status === "awaiting_approval" && item.type === "tool_execution" && <p className="activity-approval-ref"><ShieldCheck size={12} />需要审批 · 点击查看并处理</p>}
                <EventDetails item={item} content={item.type === "tool_execution" ? toolResults[item.correlation?.toolCallId ?? ""] : item.type === "model_inference" ? ((item.output as { text?: string } | null | undefined)?.text ?? messageText[item.correlation?.messageId ?? ""]) : undefined} onOpen={(title, content) => setDetail({ title, content })} />
              </article>
            </li>
          ))}
        </ol>
      )}
      </details>
      {detail && <div className="activity-detail-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setDetail(null); } }} onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}><section className="activity-detail-dialog" role="dialog" aria-modal="true" aria-labelledby={detailTitleId}><header><h3 id={detailTitleId}>{detail.title}</h3><button type="button" aria-label="关闭" onClick={() => setDetail(null)}>×</button></header><pre>{displayValue(detail.content)}</pre></section></div>}
    </section>
  );
}

/**
 * 执行 formatActivityTime 相关处理。
 * @param value value 参数。
 * @returns 执行结果。
 */
function formatActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

/**
 * 执行 readRequest 相关处理。
 * @param interrupt interrupt 参数。
 * @returns 执行结果。
 */
function readRequest(interrupt: Interrupt): ApprovalRequest | null {
  const metadata = interrupt.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const metadataRecord = metadata as Record<string, unknown>;
  const langgraph = metadataRecord.langgraph;
  const raw = langgraph && typeof langgraph === "object" && !Array.isArray(langgraph)
    ? (langgraph as Record<string, unknown>).raw
    : undefined;
  return parseApprovalRequest(raw) ?? parseApprovalRequest(metadataRecord.approvalRequest);
}

/**
 * 处理ApprovalField相关逻辑。
 * @param {
  input,
  value,
  onChange,
} {
  input,
  value,
  onChange,
} 参数。
 * @returns 函数执行结果。
 */
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
    if (input.mustBeTrue) return null;
    return (
      <fieldset className="approval-field">
        <legend>{input.label}{input.required ? " *" : ""}</legend>
        <label><input type="radio" name={`approval-${input.key}`} checked={value === true} onChange={() => onChange(true)} /> 是</label>
        {!input.mustBeTrue && <label><input type="radio" name={`approval-${input.key}`} checked={value === false} onChange={() => onChange(false)} /> 否</label>}
        {input.description && <small>{input.description}</small>}
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
        {input.description && <small>{input.description}</small>}
      </label>
    );
  }
  if (input.type === "multi_select") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="approval-field">
        <fieldset>
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
        {input.description && <small>{input.description}</small>}
      </div>
    );
  }
  return (
    <label className="approval-field">
      <span>{input.label}{input.required ? " *" : ""}</span>
      <textarea
        value={typeof value === "string" ? value : ""}
        placeholder={input.placeholder}
        maxLength={input.maxLength}
        required={input.required}
        onChange={(event) => onChange(event.target.value)}
      />
      {input.description && <small>{input.description}</small>}
      {input.maxLength !== undefined && <small>{typeof value === "string" ? value.length : 0}/{input.maxLength}</small>}
    </label>
  );
}

/**
 * 处理ApprovalCard相关逻辑。
 * @param {
  request,
  interruptId,
  message,
  resolve,
  cancel,
} {
  request,
  interruptId,
  message,
  resolve,
  cancel,
} 参数。
 * @returns 函数执行结果。
 */
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
  const [error, setError] = useState("");

  if (!request) {
    return (
      <div className="pod-restart-approval" role="alertdialog" aria-labelledby={`approval-title-${interruptId}`}>
        <div className="approval-body">
          <strong id={`approval-title-${interruptId}`}>无法读取审批请求</strong>
          <p>请求结构缺失或版本不受支持，不能提交审批。</p>
        </div>
        <div className="approval-actions"><button type="button" className="button secondary" onClick={() => void cancel(interruptId)}>关闭</button></div>
      </div>
    );
  }

    /**
 * 执行 decide 相关处理。
 * @param status status 参数。
 * @returns 执行结果。
 */
    const decide = (status: "approved" | "rejected") => {
    const submittedAnswers = status === "approved"
      ? { ...answers, ...Object.fromEntries(request.inputs.filter((input) => input.type === "confirm" && input.mustBeTrue).map((input) => [input.key, true])) }
      : answers;
    const validationError = validateApprovalDecision(request, status, submittedAnswers);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    void resolve({
      request_id: request.request_id,
      status,
      ...(status === "approved" ? { answers: submittedAnswers } : {}),
    }, interruptId);
  };

  return (
    <div className="pod-restart-approval" role="alertdialog" aria-labelledby={`approval-title-${interruptId}`}>
      <header className="approval-heading">
        <span className="approval-icon"><ShieldCheck size={18} /></span>
        <div><span className="approval-kicker">需要人工审批</span><strong id={`approval-title-${interruptId}`}>{request.title}</strong></div>
        <span className="approval-badge">待审核</span>
      </header>
      <div className="approval-body">
        {message && <p className="approval-message">{message}</p>}
        <dl className="approval-summary">
          <div><dt>执行动作</dt><dd>{request.action}</dd></div>
          <div><dt>判断原因</dt><dd>{request.rationale}</dd></div>
          <div><dt>方案与影响</dt><dd>{request.change_plan}</dd></div>
        </dl>
        {request.evidence.length > 0 && (
          <details className="approval-evidence">
            <summary>查看执行证据（{request.evidence.length} 项）</summary>
            {request.evidence.map((item, index) => (
              <pre key={index}>{JSON.stringify(item, null, 2)}</pre>
            ))}
          </details>
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
        {error && <p role="alert" className="approval-error">{error}</p>}
      </div>
      <div className="approval-actions">
        <button type="button" className="button secondary" onClick={() => void cancel(interruptId)}>取消</button>
        <button type="button" className="button secondary" onClick={() => decide("rejected")}>拒绝</button>
        <button type="button" className="button danger" onClick={() => decide("approved")}>批准并继续</button>
      </div>
    </div>
  );
}

const ApprovalContext = createContext<(event: AgentRunEvent) => void>(() => {});

/**
 * 执行 FaultAgentChatView 相关处理。
 * @param props props 参数。
 * @returns 执行结果。
 */
function FaultAgentChatView(props: ComponentProps<typeof CopilotChatView>) { return <CopilotChatView {...props} />; }

/**
 * 执行 ApprovalLayer 相关处理。
 * @param { interrupts, resolve, cancel } { interrupts, resolve, cancel } 参数。
 * @returns 执行结果。
 */
function ApprovalLayer({ interrupts, resolve, cancel }: { interrupts: Interrupt[]; resolve: (value: unknown, id?: string) => unknown; cancel: (id?: string) => unknown }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = interrupts.find((item) => item.id === selectedId);
  useEffect(() => { if (selectedId && !interrupts.some((item) => item.id === selectedId)) setSelectedId(null); }, [interrupts, selectedId]);
  // 按活动上的审批请求 ID 精确查找对应的 LangGraph 中断。
  useEffect(() => { approvalOpener.current = (event) => {
    const requestId = event.type === "approval" ? event.approval?.requestId : event.request_id;
    if (!requestId) return;
    const match = interrupts.find((item) => { const request = readRequest(item); return request?.request_id === requestId; });
    if (match) setSelectedId(match.id);
  }; return () => { approvalOpener.current = null; }; }, [interrupts]);
  return selected ? <div className="approval-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><section className="approval-modal" role="dialog" aria-modal="true"><ApprovalCard request={readRequest(selected)} interruptId={selected.id} message={selected.message} resolve={(value, id) => { const result = resolve(value, id); setSelectedId(null); return result; }} cancel={(id) => { const result = cancel(id); setSelectedId(null); return result; }} /><button className="approval-modal-close" type="button" aria-label="关闭审批框" onClick={() => setSelectedId(null)}>×</button></section></div> : null;
}

const approvalOpener: { current: ((event: AgentRunEvent) => void) | null } = { current: null };

/**
 * 执行 FaultAgent 相关处理。
 * @returns 执行结果。
 */
export default function FaultAgent() {
  const { agent, isReady } = useAgent();
  const { activities, runUsers, results, failedRuns, toolResults, messageText } = useAgentActivity(agent, isReady);
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [historyExpandedRuns, setHistoryExpandedRuns] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = useId();
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyCloseButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (historyOpen) historyCloseButton.current?.focus();
  }, [historyOpen]);

  /**
   * 关闭历史抽屉并将焦点移回历史记录按钮。
   * @returns 无返回值。
   */
  function closeHistory(): void {
    setHistoryOpen(false);
    historyButton.current?.focus();
  }

  const historyRuns = Object.values(activities).sort((a, b) =>
    Date.parse(b.activity.run.startedAt) - Date.parse(a.activity.run.startedAt),
  );
  // 跨运行按步骤开始时间选取最近三条；时间相同的步骤按序号倒序选择。
  const recentEvents = new Set(historyRuns.flatMap(({ activity }) => activity.events)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.sequence - a.sequence)
    .slice(0, 3));
    /**
 * 执行 openApproval 相关处理。
 * @param event event 参数。
 * @returns 执行结果。
 */
    const openApproval = (event: AgentRunEvent) => approvalOpener.current?.(event);
  const approval = useInterrupt({
    renderInChat: false,
    enabled: ({ name }) => name === "on_interrupt",
    render: ({ interrupt, interrupts, resolve, cancel }) => {
      const pending = interrupts.length ? interrupts : interrupt ? [interrupt] : [];
      return <ApprovalLayer interrupts={pending} resolve={resolve} cancel={cancel} />;
    },
  });

  // 聊天预览和历史抽屉共用活动数据，各自保留展开状态。
  return (
    <section className="panel fault-agent">
      <div className="panel-heading">
        <div className="list-title">
          <h2>故障分析助手</h2>
          <span className="count-pill">智能诊断</span>
        </div>
        <button
          ref={historyButton}
          className="fault-agent-history-button"
          type="button"
          aria-label="历史记录"
          title="历史记录"
          aria-expanded={historyOpen}
          aria-controls={historyOpen ? historyId : undefined}
          onClick={() => historyOpen ? closeHistory() : setHistoryOpen(true)}
        >
          <History size={17} aria-hidden="true" />
        </button>
      </div>
      <p>可查询活动告警、读取 Pod 日志并结合上下文分析故障原因。</p>
      <ApprovalContext.Provider value={openApproval}>
        {approval}
        {historyOpen && createPortal(
          <aside
            id={historyId}
            className="fault-agent-history"
            aria-labelledby={`${historyId}-title`}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) closeHistory();
            }}
          >
            <header className="fault-agent-history-heading">
              <h2 id={`${historyId}-title`}>历史时间线</h2>
              <button ref={historyCloseButton} type="button" className="fault-agent-history-button" aria-label="关闭历史时间线" onClick={closeHistory}>
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="fault-agent-history-content">
              {!historyRuns.length && <p className="fault-agent-pending">暂无执行记录。</p>}
              {historyRuns.map(({ activity, sync }, index) => (
                <ActivityTimeline
                  key={activity.run.runId}
                  activity={activity}
                  sync={sync}
                  toolResults={toolResults}
                  messageText={messageText}
                  expanded={historyExpandedRuns[activity.run.runId] ?? (index === 0 || activity.run.status === "awaiting_approval" || activity.run.status === "running")}
                  onExpandedChange={(expanded) => setHistoryExpandedRuns((current) => ({ ...current, [activity.run.runId]: expanded }))}
                />
              ))}
            </div>
          </aside>,
          document.body,
        )}
        <CopilotChat
          chatView={FaultAgentChatView}
          labels={{ chatInputPlaceholder: "例如：production/payment-api 最近有哪些故障？" }}
          messageView={{ children: ({ messages }) => {
            const turns = buildFaultAgentTurns(messages, activities, runUsers, results, failedRuns);
            return <div className="fault-agent-conversation">
              {!turns.length && <div className="fault-agent-welcome"><span className="fault-agent-welcome-icon"><Bot size={28} /></span><h3>从一个问题开始排查</h3><p>描述故障现象，或询问近期告警与资源瓶颈。<br />执行过程和分析结果会按轮次保留在这里。</p></div>}
              {turns.map((turn, index) => <section className="fault-agent-turn" key={turn.user.id} aria-label={`第 ${index + 1} 轮对话`}>
                <div className="fault-agent-question"><span className="fault-agent-turn-label">你</span><p>{turn.user.content}</p></div>
                <div className="fault-agent-reply">
                  <div className="fault-agent-reply-heading"><span className="fault-agent-avatar"><Bot size={17} /></span><b>故障分析助手</b><span>第 {index + 1} 轮</span></div>
                  {turn.runs.map(({ activity, sync }) => {
                    const runId = activity.run.runId;
                    if (activity.events.length && !activity.events.some((event) => recentEvents.has(event))) return null;
                    return (
                      <ActivityTimeline
                        key={runId}
                        activity={activity}
                        sync={sync}
                        toolResults={toolResults}
                        messageText={messageText}
                        recentEvents={recentEvents}
                        expanded={expandedRuns[runId] ?? true}
                        onExpandedChange={(expanded) => setExpandedRuns((current) => ({ ...current, [runId]: expanded }))}
                      />
                    );
                  })}
                  {turn.reply ? <section className="fault-agent-conclusion"><span className="activity-kicker">分析回复</span><Markdown content={turn.reply} /></section> : <p className="fault-agent-pending" role="status">{turn.failed || turn.runs.some(({ activity }) => activity.run.status === "failed") ? "本轮执行失败，请查看历史时间线中的错误详情。" : turn.runs.some(({ activity }) => activity.run.status === "completed") ? "本轮执行已结束，未返回文本回复。" : turn.runs.some(({ activity }) => activity.run.status === "cancelled") ? "本轮执行已取消。" : "正在分析，执行进展将在时间线中显示…"}</p>}
                </div>
              </section>)}
            </div>;
          } }}
        />
      </ApprovalContext.Provider>
    </section>
  );
}
