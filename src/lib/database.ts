import { Pool } from "pg";

let pool: Pool | undefined;

/** 获取进程级共享的 PostgreSQL 连接池，并在首次调用时校验连接环境变量。
 * @returns 已配置的 PostgreSQL 连接池。
 * @throws 缺少必需环境变量或 DB_PORT 无效时抛出错误。
 */
export function getDatabase(): Pool {
  if (pool) return pool;
  const names = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"] as const;
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`缺少数据库环境变量：${missing.join(", ")}`);
  const port = Number(process.env.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DB_PORT 必须是有效端口");
  pool = new Pool({
    host: process.env.DB_HOST,
    port,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
  return pool;
}
