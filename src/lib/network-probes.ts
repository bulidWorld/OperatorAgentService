import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
type ProbeName = "icmp" | "tcp" | "http";
type ProbeDefinition = { executable: string; args: string[]; timeoutMs: number; description?: string };

function validateHost(host: string) {
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f]/.test(host)) throw new Error("目标 host 无效");
  if (isIP(host)) return;
  const valid = host.split(".").every(label => label.length > 0 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
  if (!valid) throw new Error("目标 host 必须是有效 IP 地址或 DNS 名称");
}

async function loadAllowlist(): Promise<Record<ProbeName, ProbeDefinition>> {
  const configPath = process.env.NETWORK_DIAGNOSTICS_CONFIG || path.join(process.cwd(), "config/network-diagnostics.json");
  const raw = JSON.parse(await readFile(/* turbopackIgnore: true */ configPath, "utf8")) as { commands?: Record<string, ProbeDefinition> };
  const commands = raw.commands ?? {};
  for (const name of ["icmp", "tcp", "http"] as const) {
    const command = commands[name];
    if (!command || !path.isAbsolute(command.executable) || !Array.isArray(command.args) ||
        !Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 30000)
      throw new Error(`网络检测白名单配置缺少有效的 ${name} 命令`);
    if (command.args.some(arg => typeof arg !== "string" || /\{(?!host\}|port\}|url\})/.test(arg)))
      throw new Error(`${name} 命令参数包含无效模板`);
  }
  return commands as Record<ProbeName, ProbeDefinition>;
}

/** Execute one configured network probe. No shell is used; only configured executable/argument templates run. */
export async function runNetworkProbe(input: { type: ProbeName; host: string; port?: number; url?: string }) {
  const host = input.host.trim();
  validateHost(host);
  let url: URL | undefined;
  if (input.type === "tcp" && (!Number.isInteger(input.port) || input.port! < 1 || input.port! > 65535))
    throw new Error("TCP 检测必须提供 1 到 65535 的端口");
  if (input.type === "http") {
    if (!input.url || input.url.length > 2048) throw new Error("HTTP 检测必须提供有效 URL");
    try { url = new URL(input.url); } catch { throw new Error("URL 格式无效"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
      throw new Error("仅支持不含账号密码的 HTTP 或 HTTPS URL");
    const urlHost = url.hostname.replace(/^\[|\]$/g, "");
    validateHost(urlHost);
    if (urlHost.toLowerCase() !== host.toLowerCase()) throw new Error("URL host 必须与 host 参数一致");
  }

  const definition = (await loadAllowlist())[input.type];
  const substitutions: Record<string, string> = { host, port: String(input.port ?? ""), url: url?.toString() ?? "" };
  const args = definition.args.map(argument => argument.replace(/\{(host|port|url)\}/g, (_match, key: string) => substitutions[key]));
  const calledAt = new Date().toISOString();
  try {
    const result = await execFile(definition.executable, args, {
      timeout: definition.timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    const httpStatus = input.type === "http" ? Number(result.stdout.trim()) || null : null;
    return {
      probe: input.type, host, port: input.port ?? null, url: url?.toString() ?? null,
      reachable: input.type === "http" ? httpStatus !== null : true,
      httpOk: input.type === "http" ? httpStatus !== null && httpStatus < 400 : null,
      httpStatus, exitCode: 0, output: result.stdout.trim().slice(0, 4000),
      description: definition.description ?? null, executedAt: calledAt,
      vantagePoint: "OperatorAgentService Pod 网络命名空间",
    };
  } catch (error) {
    const cause = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    const httpStatus = input.type === "http" ? Number(cause.stdout?.trim()) || null : null;
    return {
      probe: input.type, host, port: input.port ?? null, url: url?.toString() ?? null,
      reachable: input.type === "http" && httpStatus !== null,
      httpOk: input.type === "http" && httpStatus !== null ? httpStatus < 400 : null,
      httpStatus, exitCode: typeof cause.code === "number" ? cause.code : null,
      timedOut: Boolean(cause.killed), output: (cause.stderr || cause.stdout || cause.message).slice(0, 4000),
      description: definition.description ?? null, executedAt: calledAt,
      vantagePoint: "OperatorAgentService Pod 网络命名空间",
    };
  }
}
