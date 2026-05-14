import { QUERIES, SQL_EPOCH } from "./queries.js";
import { logger } from "./log.js";

const log = logger("poll");

export class Poller {
  constructor({
    db,
    store,
    broker,
    intervalSeconds,
    lastCheckpointName,
    startupLookbackSeconds,
  }) {
    this.db = db;
    this.store = store;
    this.broker = broker;
    this.intervalMs = intervalSeconds * 1000;
    this.lastCheckpointName = lastCheckpointName;

    // Both watermarks start `startup_lookback_s` seconds in the past so
    // a mid-race restart re-fetches the history it needs to recover the
    // correct state. 0 = read since the epoch (no limit) — the state
    // machine uses DB modifyDates as anchors so already-finished rows
    // are dropped by the POST_FINISH window.
    const lookbackS = startupLookbackSeconds ?? 0;
    const startWatermark =
      lookbackS > 0
        ? formatMysqlDate(new Date(Date.now() - lookbackS * 1000))
        : SQL_EPOCH;
    this.lastModify = startWatermark;
    this.lastCpModify = startWatermark;
    // raceClassIds we have already loaded ETA samples for (each raceClassId
    // already corresponds to a single relay leg in this schema).
    this.etaSeeded = new Set();
    this.classRefreshAt = 0;
    this.lastClassCount = null;
    this.lastBroadcastFailover = null;

    this.running = false;
    this.wakeup = null;
    this.sleepHandle = null;
  }

  // Drain-then-wait loop: never starts a new tick while a previous one is
  // still in flight. With a 3 s query timeout and a 1 s interval, setInterval
  // would otherwise stack 3+ overlapping queries when the DB is unreachable.
  start() {
    if (this.running) return;
    this.running = true;
    this._loop().catch((e) => log.error(`loop crashed: ${e.message}`));
  }

  stop() {
    this.running = false;
    if (this.sleepHandle) clearTimeout(this.sleepHandle);
    if (this.wakeup) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
    }
  }

  async _loop() {
    while (this.running) {
      const startedAt = Date.now();
      try {
        await this._tick();
      } catch (e) {
        log.error(`tick crashed: ${e.message}`);
      }
      if (!this.running) break;
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, this.intervalMs - elapsed);
      if (wait > 0) await this._sleep(wait);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this.wakeup = resolve;
      this.sleepHandle = setTimeout(() => {
        this.sleepHandle = null;
        this.wakeup = null;
        resolve();
      }, ms);
    });
  }

  async _tick() {
    await this._refreshClassesIfNeeded();
    await this._pollPrewarning();
    await this._pollLastCheckpoint();
    await this._timeBasedRecompute();
    this._broadcastFailoverIfChanged();
  }

  async _refreshClassesIfNeeded() {
    const now = Date.now();
    // Refresh class list every 60 s (classes don't change much during a race).
    if (now - this.classRefreshAt < 60_000) return;
    try {
      const rows = await this.db.query(QUERIES.classes);
      this.store.setClasses(rows);
      const groupCount = this.store.groupList().length;
      // Log on transitions so an empty raceclasses table is surfaced exactly
      // once instead of either spamming or being silent.
      if (this.lastClassCount !== groupCount) {
        if (groupCount === 0) {
          log.warn(`Class list is empty (raceclasses returned ${rows.length} row(s)). Dropdown will be blank until rows appear.`);
        } else {
          log.info(`Class list refreshed: ${groupCount} group(s) from ${rows.length} raceclass row(s)`);
        }
        this.lastClassCount = groupCount;
      }
      this.broker.broadcastAll({
        type: "classes",
        classes: this.store.groupList(),
      });
      this.classRefreshAt = now;
    } catch (err) {
      // db.js already logged the underlying error. Back off 5 s before
      // retrying so we don't request the class list on every single tick.
      this.classRefreshAt = now - 60_000 + 5_000;
      log.debug(`class list refresh failed: ${err.message}`);
    }
  }

  async _pollPrewarning() {
    let rows;
    try {
      rows = await this.db.query(QUERIES.prewarningSince, [
        this.lastModify,
        this.lastModify,
      ]);
    } catch (err) {
      // FailoverPool already logs the failure and may flip active. We just
      // skip this tick — the next one will retry on whichever pool is now active.
      return;
    }

    let highWater = this.lastModify;
    const diffsByClass = new Map(); // raceClassId -> { added, updated, removed }

    for (const r of rows) {
      // advance high water to the most recent modifyDate seen in this batch
      const mod = greatestModify(r);
      if (mod && (!highWater || mod > highWater)) highWater = mod;

      const ev = this.store.upsertFromDb(r);
      if (ev.kind === "noop") continue;

      const bucket = diffsByClass.get(ev.raceClassId) ??
        diffsByClass.set(ev.raceClassId, { added: [], updated: [], removed: [] }).get(ev.raceClassId);
      if (ev.kind === "added") bucket.added.push(ev.row);
      else if (ev.kind === "updated") bucket.updated.push(ev.row);
      else if (ev.kind === "removed") bucket.removed.push({ splitId: ev.row.splitId });

      // First time we see this class, kick off ETA seeding.
      if (!this.etaSeeded.has(r.raceClassId)) {
        this.etaSeeded.add(r.raceClassId);
        this._seedEta(r.raceClassId).catch((e) =>
          log.warn(`ETA seed failed for class=${r.raceClassId}: ${e.message}`),
        );
      }
    }

    if (highWater) this.lastModify = highWater;

    for (const [raceClassId, diff] of diffsByClass) {
      if (
        diff.added.length === 0 &&
        diff.updated.length === 0 &&
        diff.removed.length === 0
      )
        continue;
      this.broker.broadcast(raceClassId, {
        type: "diff",
        ...diff,
        failover: this.db.isFailedOver(),
      });
    }
  }

  async _seedEta(raceClassId) {
    const samples = await this.db.query(QUERIES.finishedSamples, [raceClassId]);
    this.store.setFinishedSamples(raceClassId, samples);
  }

  // Watch splittimes for the configured "last checkpoint" name (looked
  // up in raceclasssplittimecontrols, same pattern as Prewarning — so
  // per-class control numbers can differ). For each new punch, anchor
  // lastCheckpointAt on the active prewarning row (if any) and broadcast
  // a diff so the client repaints the "Last" badge + stripe.
  async _pollLastCheckpoint() {
    if (!this.lastCheckpointName) return;
    let rows;
    try {
      rows = await this.db.query(QUERIES.lastCheckpointSince, [
        this.lastCheckpointName,
        this.lastCpModify,
      ]);
    } catch (err) {
      return;
    }
    let highWater = this.lastCpModify;
    const grouped = new Map();
    for (const r of rows) {
      const mod = r.stModifyDate;
      const modDate = mod
        ? mod instanceof Date
          ? mod
          : new Date(mod)
        : null;
      const modStr = modDate ? formatMysqlDate(modDate) : null;
      if (modStr && (!highWater || modStr > highWater)) highWater = modStr;

      // Anchor lastCheckpointAt at the real-clock time of the punch (the
      // splittime row's modifyDate). For live rows that's ~now; for
      // catch-up back-fill it's the actual punch time, so the state
      // machine knows whether the runner has been past the last
      // checkpoint for seconds or minutes.
      const observedAt = modDate ? modDate.getTime() : Date.now();
      const change = this.store.recordLastCheckpoint(r.resultId, observedAt);
      if (!change) continue;
      const bucket = grouped.get(change.raceClassId) ??
        grouped
          .set(change.raceClassId, { added: [], updated: [], removed: [] })
          .get(change.raceClassId);
      bucket.updated.push(change.row);
    }
    if (highWater) this.lastCpModify = highWater;

    for (const [raceClassId, diff] of grouped) {
      if (diff.updated.length === 0) continue;
      this.broker.broadcast(raceClassId, {
        type: "diff",
        ...diff,
        failover: this.db.isFailedOver(),
      });
    }
  }

  async _timeBasedRecompute() {
    const changes = this.store.tick();
    if (changes.length === 0) return;
    const grouped = new Map();
    for (const c of changes) {
      const bucket = grouped.get(c.raceClassId) ??
        grouped.set(c.raceClassId, { added: [], updated: [], removed: [] }).get(c.raceClassId);
      if (c.kind === "updated") bucket.updated.push(c.row);
      else if (c.kind === "removed") bucket.removed.push({ splitId: c.row.splitId });
    }
    for (const [raceClassId, diff] of grouped) {
      this.broker.broadcast(raceClassId, {
        type: "diff",
        ...diff,
        failover: this.db.isFailedOver(),
      });
    }
  }

  _broadcastFailoverIfChanged() {
    const active = this.db.isFailedOver();
    if (this.lastBroadcastFailover === active) return;
    this.lastBroadcastFailover = active;
    this.broker.broadcastAll({ type: "failover", active });
  }
}

function greatestModify(r) {
  const candidates = [r.stModifyDate, r.resModifyDate]
    .filter(Boolean)
    .map((v) => (v instanceof Date ? v : new Date(v)));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.getTime() - a.getTime());
  // mysql2 returns Date objects when dateStrings is false; format for re-binding.
  return formatMysqlDate(candidates[0]);
}

function formatMysqlDate(d) {
  // YYYY-MM-DD HH:MM:SS in this process's local TZ. Must match the
  // mysql2 `timezone: "local"` setting in db.js so the round-trip stays
  // consistent: a Date read from the DB → formatted here → bound back
  // into a WHERE clause produces a string that compares correctly
  // against the column's stored value (which is stored in the DB
  // server's local TZ; we assume Node and DB share that TZ).
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}
