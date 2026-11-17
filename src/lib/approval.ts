export type ApprovalOption = { value: string; label: string };

export type ApprovalInput = {
  key: string;
  label: string;
  type: "confirm" | "single_select" | "multi_select" | "text";
  required: boolean;
  placeholder?: string;
  options?: ApprovalOption[];
  max_length?: number;
};

export type ApprovalEvidence = {
  kind: string;
  source: string;
  summary: string;
  url?: string;
  timestamp?: string;
};

export type ApprovalRequest = {
  type: "approval_request";
  schema_version: 1;
  request_id: string;
  action: string;
  title: string;
  rationale: string;
  change_plan: string;
  evidence: ApprovalEvidence[];
  inputs: ApprovalInput[];
};

export type ApprovalDecision = {
  request_id: string;
  status: "approved" | "rejected";
  answers: Record<string, boolean | string | string[]>;
  comment?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Parse only the supported v1 request shape; malformed requests cannot be approved. */
export function parseApprovalRequest(value: unknown): ApprovalRequest | null {
  if (!isRecord(value) || value.type !== "approval_request" || value.schema_version !== 1) return null;
  if (
    typeof value.request_id !== "string" || !value.request_id.trim() ||
    typeof value.action !== "string" || !value.action.trim() ||
    typeof value.title !== "string" || !value.title.trim() ||
    typeof value.rationale !== "string" || typeof value.change_plan !== "string" ||
    !Array.isArray(value.evidence) || !Array.isArray(value.inputs)
  ) return null;

  const evidence = value.evidence as unknown[];
  if (!evidence.every((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || !item.kind || typeof item.source !== "string" || !item.source || typeof item.summary !== "string") return false;
    if (item.url !== undefined) {
      if (typeof item.url !== "string") return false;
      try {
        if (!["http:", "https:"].includes(new URL(item.url).protocol)) return false;
      } catch {
        return false;
      }
    }
    return item.timestamp === undefined || (typeof item.timestamp === "string" && !Number.isNaN(Date.parse(item.timestamp)));
  })) return null;

  const keys = new Set<string>();
  for (const item of value.inputs as unknown[]) {
    if (!isRecord(item) || typeof item.key !== "string" || !item.key.trim() || keys.has(item.key) || typeof item.label !== "string" || !item.label.trim() || typeof item.required !== "boolean") return null;
    keys.add(item.key);
    if (item.placeholder !== undefined && typeof item.placeholder !== "string") return null;
    if (item.type === "confirm") {
      if (item.options !== undefined || item.max_length !== undefined) return null;
    } else if (item.type === "single_select" || item.type === "multi_select") {
      if (!Array.isArray(item.options) || item.options.length === 0 || item.max_length !== undefined) return null;
      const values = new Set<string>();
      if (!item.options.every((option) => isRecord(option) && typeof option.value === "string" && option.value.length > 0 && typeof option.label === "string" && option.label.length > 0 && !values.has(option.value) && Boolean(values.add(option.value)))) return null;
    } else if (item.type === "text") {
      if (item.options !== undefined || (item.max_length !== undefined && (!Number.isInteger(item.max_length) || Number(item.max_length) < 0))) return null;
    } else {
      return null;
    }
  }

  return value as unknown as ApprovalRequest;
}

export function validateApprovalAnswers(
  request: ApprovalRequest,
  answers: Record<string, unknown>,
): string | null {
  const allowedKeys = new Set(request.inputs.map((input) => input.key));
  if (Object.keys(answers).some((key) => !allowedKeys.has(key))) return "答案包含请求未声明的字段。";

  for (const input of request.inputs) {
    const answer = answers[input.key];
    if (input.type === "confirm") {
      if (input.required && typeof answer !== "boolean") return `请完成“${input.label}”确认。`;
      if (answer !== undefined && typeof answer !== "boolean") return `“${input.label}”必须是是/否。`;
    } else if (input.type === "single_select") {
      if (answer === undefined && !input.required) continue;
      if (typeof answer !== "string" || !input.options?.some((option) => option.value === answer)) return `请为“${input.label}”选择有效选项。`;
    } else if (input.type === "multi_select") {
      if (answer === undefined && !input.required) continue;
      if (!Array.isArray(answer) || !answer.every((value) => typeof value === "string" && input.options?.some((option) => option.value === value)) || new Set(answer).size !== answer.length || (input.required && answer.length === 0)) return `请为“${input.label}”选择有效选项。`;
    } else if (input.type === "text") {
      if (answer === undefined && !input.required) continue;
      if (typeof answer !== "string" || (input.required && !answer.trim()) || (input.max_length !== undefined && answer.length > input.max_length)) return `请检查“${input.label}”的内容${input.max_length === undefined ? "" : `（最多 ${input.max_length} 个字符）`}。`;
    }
  }
  return null;
}
