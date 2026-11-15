"use client";

import { useState } from "react";
import { CopilotChat, useAgent, useInterrupt } from "@copilotkit/react-core/v2";
import type {
  ApprovalInput,
  ApprovalRequest,
} from "@/lib/approval";
import { parseApprovalRequest, validateApprovalAnswers } from "@/lib/approval";

type ToolCall = { id: string; function?: { name?: string; arguments?: unknown } };

function readRequest(raw: unknown): ApprovalRequest | null {
  if (typeof raw === "string") {
    try {
      return parseApprovalRequest(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return parseApprovalRequest(raw);
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
  const { agent } = useAgent();
  const approval = useInterrupt({
    renderInChat: false,
    enabled: ({ name }) => name === "on_interrupt",
    render: ({ interrupt, interrupts, resolve, cancel }) => {
      const pending = interrupts.length ? interrupts : interrupt ? [interrupt] : [];
      return (
        <div className="pod-restart-approvals" aria-live="polite">
          {pending.map((item) => {
            const toolCall = agent.messages
              .flatMap((message) => (message as { toolCalls?: ToolCall[] }).toolCalls ?? [])
              .find((call) => call.id === item.toolCallId);
            const request = readRequest(toolCall?.function?.arguments);
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
      <CopilotChat labels={{ chatInputPlaceholder: "例如：production/payment-api 最近有哪些故障？" }} />
      {approval}
    </section>
  );
}
