import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function readYaml(p) {
  return yaml.load(fs.readFileSync(p, "utf8"));
}

function fromEnv() {
  const env = process.env;
  if (!env.PREWARNING_MYSQL_PRIMARY_HOST) return null;
  return {
    mysql: {
      primary: {
        host: env.PREWARNING_MYSQL_PRIMARY_HOST,
        port: Number(env.PREWARNING_MYSQL_PRIMARY_PORT || 3306),
        user: env.PREWARNING_MYSQL_PRIMARY_USER,
        password: env.PREWARNING_MYSQL_PRIMARY_PASSWORD,
        database: env.PREWARNING_MYSQL_PRIMARY_DATABASE,
      },
      secondary: {
        host: env.PREWARNING_MYSQL_SECONDARY_HOST || "",
        port: Number(env.PREWARNING_MYSQL_SECONDARY_PORT || 3306),
        user: env.PREWARNING_MYSQL_SECONDARY_USER || "",
        password: env.PREWARNING_MYSQL_SECONDARY_PASSWORD || "",
        database:
          env.PREWARNING_MYSQL_SECONDARY_DATABASE ||
          env.PREWARNING_MYSQL_PRIMARY_DATABASE,
      },
    },
    poll_interval_ms: Number(env.PREWARNING_POLL_INTERVAL_MS || 1000),
    http_port: Number(env.PREWARNING_HTTP_PORT || 8080),
    failover: {
      failures_before_switch: Number(env.PREWARNING_FAILOVER_FAILURES || 3),
      query_timeout_ms: Number(env.PREWARNING_QUERY_TIMEOUT_MS || 3000),
      primary_recheck_ms: Number(env.PREWARNING_PRIMARY_RECHECK_MS || 30000),
    },
  };
}

export function loadConfig() {
  const explicit = process.env.PREWARNING_CONFIG;
  const candidates = [
    explicit,
    path.join(root, "config.yml"),
    path.join(root, "config.yaml"),
    "/etc/prewarning/config.yml",
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const cfg = readYaml(p);
      cfg.__source = p;
      return withDefaults(cfg);
    }
  }

  const env = fromEnv();
  if (env) {
    env.__source = "env";
    return withDefaults(env);
  }

  throw new Error(
    `No config found. Looked in: ${candidates.join(", ")}. Copy config.example.yml to config.yml or set PREWARNING_MYSQL_PRIMARY_* env vars.`,
  );
}

function withDefaults(cfg) {
  cfg.poll_interval_ms ??= 1000;
  cfg.http_port ??= 8080;
  cfg.failover ??= {};
  cfg.failover.failures_before_switch ??= 3;
  cfg.failover.query_timeout_ms ??= 3000;
  cfg.failover.primary_recheck_ms ??= 30000;
  return cfg;
}
