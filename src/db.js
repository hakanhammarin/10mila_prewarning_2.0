import mysql from "mysql2/promise";
import { logger } from "./log.js";

const log = logger("db");

function makePool(conf, queryTimeoutSeconds) {
  return mysql.createPool({
    host: conf.host,
    port: conf.port || 3306,
    user: conf.user,
    password: conf.password,
    database: conf.database,
    waitForConnections: true,
    connectionLimit: 4,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    dateStrings: false,
    // OLA stores DATETIME values in the DB server's local timezone (typically
    // Europe/Stockholm). With timezone: "Z" mysql2 would parse them as UTC,
    // putting every Date object ~2h in the future and making the prewarning
    // countdown show 122-ish minutes instead of 3:00. "local" tells mysql2
    // to interpret stored DATETIMEs as the Node process's local TZ — which
    // works as long as the prewarning service runs in the same TZ as OLA's
    // MySQL (set TZ=Europe/Stockholm if your distro defaults to UTC).
    timezone: "local",
    // OLA stores Swedish characters (åäö) as utf8mb4. Without this pin the
    // mysql2 default (utf8mb4_general_ci on most servers) usually works, but
    // some installs negotiate latin1 and class names come back as mojibake
    // ("Sträcka" -> "StrÃ¤cka"). Force utf8mb4 to be safe.
    charset: "utf8mb4",
    // mysql2 expects ms; config is in seconds.
    connectTimeout: queryTimeoutSeconds * 1000,
  });
}

function isConfigured(conf) {
  return Boolean(conf && conf.host && conf.user && conf.database);
}

export class FailoverPool {
  constructor(cfg) {
    this.cfg = cfg;
    this.failover = cfg.failover;
    this.primary = makePool(cfg.mysql.primary, this.failover.query_timeout_s);
    this.secondary = isConfigured(cfg.mysql.secondary)
      ? makePool(cfg.mysql.secondary, this.failover.query_timeout_s)
      : null;
    this.active = "primary";
    this.consecutiveFailures = 0;
    this.recheckTimer = null;
    this.listeners = new Set();
  }

  onActiveChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.active);
      } catch {
        // ignore listener errors
      }
    }
  }

  isFailedOver() {
    return this.active === "secondary";
  }

  async query(sql, params = []) {
    const pool = this.active === "primary" ? this.primary : this.secondary;
    if (!pool) {
      throw new Error("No active database pool available");
    }
    try {
      const [rows] = await this._withTimeout(
        pool.query(sql, params),
        this.failover.query_timeout_s * 1000,
      );
      if (this.active === "primary") this.consecutiveFailures = 0;
      return rows;
    } catch (err) {
      if (this.active === "primary") {
        const prev = this.consecutiveFailures;
        this.consecutiveFailures = prev + 1;
        const threshold = this.failover.failures_before_switch;
        if (this.consecutiveFailures <= threshold) {
          log.warn(
            `Primary query failed (${this.consecutiveFailures}/${threshold}): ${err.message}`,
          );
          if (this.consecutiveFailures === threshold) {
            if (this.secondary) {
              this._switchTo("secondary");
            } else {
              log.warn(
                `Primary unreachable and no secondary configured — will keep retrying quietly. Set mysql.secondary in config to enable failover.`,
              );
            }
          }
        } else {
          // Already past the threshold — DB is known-down. Demote to debug so
          // we don't flood journalctl every second.
          log.debug(`Primary still failing: ${err.message}`);
        }
      } else {
        log.warn(`Secondary query failed: ${err.message}`);
      }
      throw err;
    }
  }

  _withTimeout(p, ms) {
    return Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`query timeout after ${ms}ms`)), ms),
      ),
    ]);
  }

  _switchTo(target) {
    if (this.active === target) return;
    log.info(`Switching active DB: ${this.active} -> ${target}`);
    this.active = target;
    this.consecutiveFailures = 0;
    this._emit();
    if (target === "secondary") this._schedulePrimaryRecheck();
  }

  _schedulePrimaryRecheck() {
    if (this.recheckTimer) return;
    const tick = async () => {
      try {
        const [rows] = await this._withTimeout(
          this.primary.query("SELECT 1 AS ok"),
          this.failover.query_timeout_s * 1000,
        );
        if (rows && rows[0]?.ok === 1) {
          log.info("Primary reachable again");
          clearInterval(this.recheckTimer);
          this.recheckTimer = null;
          this._switchTo("primary");
        }
      } catch (err) {
        log.debug(`Primary still down: ${err.message}`);
      }
    };
    this.recheckTimer = setInterval(tick, this.failover.primary_recheck_s * 1000);
  }

  async close() {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    await this.primary.end().catch(() => {});
    if (this.secondary) await this.secondary.end().catch(() => {});
  }
}
