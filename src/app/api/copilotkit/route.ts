import { createOpenAI } from "@ai-sdk/openai";
import {
  BuiltInAgent,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import { copilotPrompt } from "./prompt";
import { copilotTools } from "./tools";

export const runtime = "nodejs";

/** Process-local lazy cache: initialize provider, Agent and HTTP handler once per worker. */
let handler: ReturnType<typeof createCopilotHonoHandler> | undefined;

function getHandler() {
  if (handler) return handler;
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_BASE_URL;
  const modelName = process.env.LLM_MODEL;
  if (!apiKey || !baseURL || !modelName)
    throw new Error("请配置 LLM_BASE_URL、LLM_API_KEY 和 LLM_MODEL");
  let endpoint: URL;
  try {
    endpoint = new URL(baseURL);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error("invalid endpoint");
  } catch {
    throw new Error("LLM_BASE_URL 必须是有效的 HTTP(S) API 根地址，例如 https://api.openai.com/v1");
  }
  const provider = createOpenAI({
    apiKey,
    baseURL: endpoint.toString().replace(/\/$/, ""),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok) {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        console.error("LLM request failed", { status: response.status, path, model: modelName });
        if (response.status === 501)
          throw new Error(`模型服务返回 HTTP 501：请确认 LLM_BASE_URL 指向支持 ${path} 的 OpenAI 兼容服务，并检查 LLM_MODEL`);
      }
      return response;
    },
  });
  const agent = new BuiltInAgent({
    model: provider.chat(modelName),
    tools: copilotTools,
    maxSteps: 8,
    prompt: copilotPrompt,
  });
  const copilotRuntime = new CopilotRuntime({ agents: { default: agent } });
  handler = createCopilotHonoHandler({
    runtime: copilotRuntime,
    basePath: "/api/copilotkit",
    mode: "single-route",
  });
  return handler;
}

async function handle(request: Request) {
  try {
    return await getHandler().fetch(request);
  } catch (error) {
    console.error("CopilotKit request failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Agent 请求失败" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
