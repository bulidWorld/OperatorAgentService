"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-ui/v2/styles.css";

/**
 * 处理CopilotProvider相关逻辑。
 * @param {
  children,
} {
  children,
} 参数。
 * @returns 函数执行结果。
 */
export default function CopilotProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint>
      {children}
    </CopilotKit>
  );
}
