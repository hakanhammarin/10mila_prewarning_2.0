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
    poll_interval_s: Number(env.PREWARNING_POLL_INTERVAL_S || 1),
    http_port: Number(env.PREWARNING_HTTP_PORT || 8080),
    failover: {
      failures_before_switch: Number(env.PREWARNING_FAILOVER_FAILURES || 3),
      query_timeout_s: Number(env.PREWARNING_QUERY_TIMEOUT_S || 3),
      primary_recheck_s: Number(env.PREWARNING_PRIMARY_RECHECK_S || 30),
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
  // Top-level: support legacy *_ms keys for one release so existing
  // operators don't have to update their config.yml in the same deploy
  // that pulls this code. Internal callers always use *_s.
  if (cfg.poll_interval_s == null && cfg.poll_interval_ms != null) {
    cfg.poll_interval_s = cfg.poll_interval_ms / 1000;
  }
  cfg.poll_interval_s ??= 1;
  cfg.http_port ??= 8080;

  cfg.failover ??= {};
  if (cfg.failover.query_timeout_s == null && cfg.failover.query_timeout_ms != null) {
    cfg.failover.query_timeout_s = cfg.failover.query_timeout_ms / 1000;
  }
  if (cfg.failover.primary_recheck_s == null && cfg.failover.primary_recheck_ms != null) {
    cfg.failover.primary_recheck_s = cfg.failover.primary_recheck_ms / 1000;
  }
  cfg.failover.failures_before_switch ??= 3;
  cfg.failover.query_timeout_s ??= 3;
  cfg.failover.primary_recheck_s ??= 30;

  cfg.state ??= {};
  cfg.state.green_s ??= 60;
  cfg.state.yellow_remaining_s ??= 60;
  cfg.state.post_finish_remove_s ??= 5;
  cfg.state.default_eta_s ??= 180;
  cfg.state.eta_sample_min_s ??= 2;
  cfg.state.eta_sample_max_s ??= 600;
  cfg.state.eta_sample_keep ??= 50;
  // Minimum time the prewarning (GREEN/YELLOW) phase is visible when a
  // finish punch arrives in the SAME poll as the prewarn — SimOLA's
  // fast-replay collapses prewarn+finish+readout into one observation,
  // so without this delay the row would jump straight to RED. In a real
  // race finish arrives minutes after prewarn so the delay never engages
  // (real-time path anchors at observation moment).
  cfg.state.min_prewarn_dwell_s ??= 60;

  // On startup, fetch splittime rows that have been modified within the
  // last `startup_lookback_s` seconds, then fast-forward the state
  // machine through them so the current display reflects "what's
  // happening now" after a disruption. Rows that finished too long ago
  // (>post_finish_remove_s in real time) are dropped automatically by
  // the state machine's POST_FINISH window; currently-active rows are
  // anchored at their actual DB modifyDate.
  //
  // 0 means "read all history since the epoch" — the cheapest way to
  // recover full state after a long outage; the cost is one query that
  // returns every prewarn ever, but the state machine still filters out
  // anything past its lifecycle so memory stays bounded.
  cfg.state.startup_lookback_s ??= 0;

  cfg.state.yellow_mode ??= "time";
  // Back-compat: older configs used `last_checkpoint_control: <number>`
  // (matched against splittimes.timingControl). We now look up by name in
  // raceclasssplittimecontrols (same pattern as Prewarning). If the old
  // key is present, coerce it to a string so the new query still works.
  if (
    cfg.state.last_checkpoint_name == null &&
    cfg.state.last_checkpoint_control != null
  ) {
    cfg.state.last_checkpoint_name = String(cfg.state.last_checkpoint_control);
  }
  cfg.state.last_checkpoint_name ??= "100";
  cfg.state.last_checkpoint_name = String(cfg.state.last_checkpoint_name);

  // Normalize yellow_mode.
  const ym = String(cfg.state.yellow_mode).toLowerCase();
  if (ym !== "time" && ym !== "checkpoint") {
    throw new Error(
      `Invalid state.yellow_mode: ${cfg.state.yellow_mode}. ` +
        `Expected "time" or "checkpoint".`,
    );
  }
  cfg.state.yellow_mode = ym;

  return cfg;
}
