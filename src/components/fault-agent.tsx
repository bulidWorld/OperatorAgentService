"use client";

import { CopilotChat, useAgent, useInterrupt } from "@copilotkit/react-core/v2";

type ApprovalArgs = {
  namespace?: string;
  pod?: string;
  reason?: string;
};

function readApprovalArgs(raw: unknown): ApprovalArgs {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ApprovalArgs;
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as ApprovalArgs) : {};
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
              .flatMap((message) =>
                (message as { toolCalls?: Array<{ id: string; function?: { name?: string; arguments?: unknown } }> }).toolCalls ?? [],
              )
              .find((call) => call.id === item.toolCallId);
            const args = readApprovalArgs(toolCall?.function?.arguments);
            const title = toolCall?.function?.name === "request_pod_restart_approval"
              ? "重启 Pod"
              : "执行 Kubernetes 操作";
            const canApprove = title === "重启 Pod" && Boolean(args.namespace && args.pod && args.reason);

            return (
              <div className="pod-restart-approval" role="alertdialog" aria-labelledby={`approval-title-${item.id}`} key={item.id}>
                <strong id={`approval-title-${item.id}`}>需要人工审批：{title}</strong>
                <p>{item.message ?? "Agent 请求执行一项 Kubernetes 变更。"}</p>
                {args.namespace && <p><b>Namespace：</b><code>{args.namespace}</code></p>}
                {args.pod && <p><b>Pod：</b><code>{args.pod}</code></p>}
                {args.reason && <p><b>原因：</b>{args.reason}</p>}
                {!canApprove && <p role="alert">无法读取完整的操作目标或原因，因此不能批准。</p>}
                <p>批准后将删除该 Pod；控制器是否重建取决于它的工作负载配置。</p>
                <div>
                  <button type="button" className="button secondary" onClick={() => void cancel(item.id)}>拒绝</button>
                  <button type="button" className="button danger" disabled={!canApprove} onClick={() => void resolve({ approved: true }, item.id)}>批准并继续</button>
                </div>
              </div>
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
      <CopilotChat
        labels={{
          chatInputPlaceholder: "例如：production/payment-api 最近有哪些故障？",
        }}
      />
      {approval}
    </section>
  );
}
