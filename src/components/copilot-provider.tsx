"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-ui/v2/styles.css";

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
