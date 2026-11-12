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
  const provider = createOpenAI({ apiKey, baseURL });
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
