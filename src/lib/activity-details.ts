/**
 * 将文本消息增量追加到对应消息的累计文本中。
 * @param messages 当前消息编号到文本内容的映射。
 * @param messageId 文本所属的消息编号。
 * @param delta 本次收到的文本增量。
 * @returns 包含更新后文本的新映射。
 */
export function appendMessageText(
  messages: Record<string, string>,
  messageId: string,
  delta: string,
): Record<string, string> {
  return { ...messages, [messageId]: `${messages[messageId] ?? ""}${delta}` };
}

/**
 * 按工具调用编号保存工具结果，供活动事件关联查询。
 * @param results 当前工具调用编号到结果的映射。
 * @param toolCallId 工具调用编号。
 * @param content 工具返回的内容。
 * @returns 包含新结果的新映射。
 */
export function storeToolResult(
  results: Record<string, unknown>,
  toolCallId: string,
  content: unknown,
): Record<string, unknown> {
  return { ...results, [toolCallId]: content };
}

/**
 * 执行 correlatedModelText 相关处理。
 * @param messages messages 参数。
 * @param messageId messageId 参数。
 * @returns 执行结果。
 */
export function correlatedModelText(
  messages: Record<string, string>,
  messageId: string,
): string | undefined {
  return messages[messageId];
}

/**
 * 执行 correlatedToolResult 相关处理。
 * @param results results 参数。
 * @param toolCallId toolCallId 参数。
 * @returns 执行结果。
 */
export function correlatedToolResult(
  results: Record<string, unknown>,
  toolCallId: string,
): unknown {
  return results[toolCallId];
}
