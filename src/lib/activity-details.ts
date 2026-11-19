/** Append a TEXT_MESSAGE_CONTENT delta to the accumulated text for its message. */
export function appendMessageText(
  messages: Record<string, string>,
  messageId: string,
  delta: string,
): Record<string, string> {
  return { ...messages, [messageId]: `${messages[messageId] ?? ""}${delta}` };
}

/** Store TOOL_CALL_RESULT content under its tool_call_id for activity correlation. */
export function storeToolResult(
  results: Record<string, unknown>,
  toolCallId: string,
  content: unknown,
): Record<string, unknown> {
  return { ...results, [toolCallId]: content };
}

export function correlatedModelText(
  messages: Record<string, string>,
  messageId: string,
): string | undefined {
  return messages[messageId];
}

export function correlatedToolResult(
  results: Record<string, unknown>,
  toolCallId: string,
): unknown {
  return results[toolCallId];
}
