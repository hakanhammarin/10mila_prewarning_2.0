// In-memory state per (raceClassId, splitId).
//
// State machine:
//   prewarn punched         -> GREEN
//     70s elapsed                       \
//     OR <=90s remaining of countdown    } -> YELLOW
//                                         (whichever fires first)
//   finishTime set          -> RED, 30s post-finish countdown shown
//     readInTime set                    \
//     OR 30s elapsed since finishTime    } -> remove
//                                         (whichever fires first)
//
// Countdown anchor: `prewarnAt` on a stored row is the SERVER's wall clock
// at the moment the row was first observed — NOT the DB's `passedTime`.
// `finishAt` on a stored row is the SERVER's wall clock at the moment we
// first observed `results.finishTime` set on this row — NOT OLA's
// race-time finish stamp. Both anchors are locked on first observation
// and survive later poll updates, so finish/remove transitions don't
// restart the countdown and (critically) so SimOLA-replay's future-dated
// finishTimes don't suppress the "Finish" announcement. This keeps the
// 3:00 countdown and the 5 s post-finish window honest across simulator
// replays, app restarts, and any timezone / clock skew between OLA's
// MySQL and this service.
//
// Pre-finish countdown shown on each row = (prewarnAt + etaSeconds) - now.
// Post-finish countdown shown = (finishAt + POST_FINISH_REMOVE_MS) - now,
// so the row stays RED with the "until removal" timer visible. ETA starts
// at DEFAULT_ETA_S (= 3:00) and, as soon as a single completed-runner
// sample lands inside [ETA_SAMPLE_MIN_S, MAX_ETA_SAMPLE_S], switches to
// the running AVERAGE of all in-range samples (capped at the most recent 50).
//
// Stale-readInTime guard: OLA's `rawdata.readInTime` column is rarely
// reset between race replays, so a fresh prewarn punch routinely arrives
// for a runner whose rawdata row was read minutes/hours ago in a previous
// run. We only treat readInTime as a "remove" trigger when it post-dates
// the prewarn punch (DB-clock comparison); otherwise the row would be
// filtered the instant it shows up — which is the symptom seen on the
// dual-runner Ungdomskavlen legs.
//
// Rows are keyed by splitTimeId (one Prewarning per runner per race),
// grouped by raceClassId for SSE fan-out.

const GREEN_MS = 60000;
const YELLOW_REMAINING_MS = 60000;
const POST_FINISH_REMOVE_MS = 5000;
const DEFAULT_ETA_S = 180;
// Realistic prewarn→finish bounds for a relay leg: drop anything under
// 2 s as clock noise / replay artifacts and anything above 10 min as an
// outlier that would warp the rolling average. The real samples we see
// in the Ungdomskavlen data sit around 90–120 s, so 600 s gives plenty
// of headroom for slower legs and individual classes.
const ETA_SAMPLE_MIN_S = 2;
const MAX_ETA_SAMPLE_S = 600;
const ETA_SAMPLE_KEEP = 50;

// Exposed so the server can ship the default value down to the topbar
// display — the client compares row.etaSeconds against this to decide
// whether the measured average is currently overriding the default.
export const DEFAULT_ETA_SECONDS = DEFAULT_ETA_S;

export class Store {
  constructor() {
    /** raceClassId -> Map(splitId -> row) */
    this.byClass = new Map();
    /** raceClassId -> { samples: number[], etaSeconds: number }
     *  (each raceClassId already corresponds to a single relay leg). */
    this.etaByClass = new Map();
    /** eventClassId -> { id, name, raceClassIds: number[] } */
    this.groups = new Map();
  }

  // rows: [{ eventClassId, name, raceClassId, relayLeg }, ...]
  // One row per (eventClassId × raceClassId). Multiple rows with the same
  // eventClassId are collapsed into a single group whose raceClassIds
  // covers every leg.
  setClasses(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (r.eventClassId == null) continue;
      let g = groups.get(r.eventClassId);
      if (!g) {
        g = { id: r.eventClassId, name: r.name, raceClassIds: [] };
        groups.set(r.eventClassId, g);
      }
      if (r.raceClassId != null) g.raceClassIds.push(r.raceClassId);
    }
    this.groups = groups;
  }

  groupList() {
    return [...this.groups.values()]
      .map((g) => ({ id: g.id, name: g.name, raceClassIds: g.raceClassIds }))
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  }

  // Resolve a ?class= URL parameter (numeric eventClassId or display name)
  // to a group descriptor, or null if no match.
  resolveGroup(param) {
    if (/^\d+$/.test(param)) {
      const id = Number(param);
      const g = this.groups.get(id);
      return g
        ? { id: g.id, name: g.name, raceClassIds: g.raceClassIds }
        : null;
    }
    const target = param.toLowerCase();
    for (const g of this.groups.values()) {
      if (g.name.toLowerCase() === target) {
        return { id: g.id, name: g.name, raceClassIds: g.raceClassIds };
      }
    }
    return null;
  }

  rowsForGroup(group) {
    const out = [];
    for (const rcId of group.raceClassIds) {
      const m = this.byClass.get(rcId);
      if (!m) continue;
      for (const r of m.values()) out.push(r);
    }
    out.sort((a, b) => a.prewarnAt - b.prewarnAt);
    return out;
  }

  ensureClass(raceClassId) {
    if (!this.byClass.has(raceClassId)) this.byClass.set(raceClassId, new Map());
    return this.byClass.get(raceClassId);
  }

  // Apply DB row to in-memory state. Returns { added, updated, removed }.
  upsertFromDb(dbRow) {
    const raceClassId = dbRow.raceClassId;
    if (raceClassId == null) return { kind: "noop" };

    const map = this.ensureClass(raceClassId);
    const splitId = dbRow.splitId;
    const prev = map.get(splitId);

    // Detect the prewarn→finish transition using the DB stamps (those are
    // the only thing that tells us "a finish punch just landed"), but
    // ANCHOR the state-machine clock to the server's now-time on that
    // transition. SimOLA's Schedule_Replay writes finishTime with the
    // SIMULATED race time, which is currently ~40 min in the future of
    // real wall clock — gating on `finishAt <= now` would hide the finish
    // announcement entirely. Anchoring server-side means: as soon as we
    // observe a fresh finishTime on a row, the 5 s "Finish" window starts.
    const dbPrewarnMs = toMs(dbRow.prewarnAt);
    const dbFinishMs = toMs(dbRow.finishTime);
    const justFinished = dbFinishMs != null && !prev?.finishAt;
    if (justFinished && dbPrewarnMs) {
      this.recordFinishedSample(raceClassId, dbPrewarnMs, dbFinishMs);
    }

    // Server-time anchors: lock on first observation, never restart.
    const anchorAt = prev?.prewarnAt ?? Date.now();
    // finishAt is null if no DB finish yet; otherwise it's the server-
    // observed timestamp of the *transition* (preserved across later polls).
    // If DB finishTime gets cleared (prep / cleanup), un-anchor.
    let finishAnchor;
    if (dbFinishMs == null) finishAnchor = null;
    else if (prev?.finishAt != null) finishAnchor = prev.finishAt;
    else finishAnchor = Date.now();

    const next = projectRow(
      dbRow,
      this.etaSeconds(raceClassId),
      anchorAt,
      finishAnchor,
    );

    if (next.removed) {
      if (prev) {
        map.delete(splitId);
        return { kind: "removed", raceClassId, row: prev };
      }
      return { kind: "noop" };
    }

    map.set(splitId, next);
    if (!prev) return { kind: "added", raceClassId, row: next };
    if (rowEqualForUI(prev, next)) return { kind: "noop" };
    return { kind: "updated", raceClassId, row: next };
  }

  // Re-evaluate all rows against the wall clock (state transitions GREEN
  // -> YELLOW based on elapsed time, fallback removal on finishTime + 2 min).
  // Returns a list of changes.
  tick(now = Date.now()) {
    const changes = [];
    for (const [raceClassId, map] of this.byClass) {
      for (const [splitId, row] of map) {
        const refreshed = recomputeStripe(row, now);
        if (refreshed.removed) {
          map.delete(splitId);
          changes.push({ kind: "removed", raceClassId, row });
          continue;
        }
        if (!rowEqualForUI(row, refreshed)) {
          map.set(splitId, refreshed);
          changes.push({ kind: "updated", raceClassId, row: refreshed });
        }
      }
    }
    return changes;
  }

  // Inject finished samples to seed the rolling average. Samples outside
  // [ETA_SAMPLE_MIN_S, MAX_ETA_SAMPLE_S] are dropped as noise/outliers.
  // The ETA switches to the average as soon as a single in-range sample
  // exists; otherwise DEFAULT_ETA_S stays in effect.
  setFinishedSamples(raceClassId, samples) {
    const durations = samples
      .map((s) => durationSeconds(s.prewarnAt, s.finishTime))
      .filter((s) => s != null && s >= ETA_SAMPLE_MIN_S && s <= MAX_ETA_SAMPLE_S)
      .slice(-ETA_SAMPLE_KEEP);
    this._setEtaFromDurations(raceClassId, durations);
  }

  // Incremental sample: called from upsertFromDb whenever a row's finishAt
  // transitions from unset to set, so the ETA tightens up live during a race
  // without waiting for the next full seed query.
  recordFinishedSample(raceClassId, prewarnAtMs, finishAtMs) {
    const dur = durationSeconds(prewarnAtMs, finishAtMs);
    if (dur == null || dur < ETA_SAMPLE_MIN_S || dur > MAX_ETA_SAMPLE_S) return;
    const cur = this.etaByClass.get(raceClassId);
    const next = cur ? [...cur.samples, dur] : [dur];
    if (next.length > ETA_SAMPLE_KEEP) next.splice(0, next.length - ETA_SAMPLE_KEEP);
    this._setEtaFromDurations(raceClassId, next);
  }

  _setEtaFromDurations(raceClassId, durations) {
    const eta = durations.length >= 1
      ? Math.round(average(durations))
      : DEFAULT_ETA_S;
    this.etaByClass.set(raceClassId, { samples: durations, etaSeconds: eta });
    // Refresh existing rows in this class with the new ETA.
    const map = this.byClass.get(raceClassId);
    if (!map) return;
    for (const [splitId, row] of map) {
      if (row.etaSeconds !== eta) map.set(splitId, { ...row, etaSeconds: eta });
    }
  }

  etaSeconds(raceClassId) {
    return this.etaByClass.get(raceClassId)?.etaSeconds ?? DEFAULT_ETA_S;
  }
}

function projectRow(db, etaSeconds, anchorAt, finishAnchor) {
  const dbPrewarnAt = toMs(db.prewarnAt);
  const readInAt = toMs(db.readInTime);
  const now = Date.now();

  // readInTime is a "remove" trigger only when it post-dates the prewarn
  // punch in DB-clock terms. Stale readInTimes from a previous OLA replay
  // (where rawdata.readInTime was never cleared) would otherwise drop
  // every freshly-prewarned row immediately — the Ungdomskavlen dual-
  // runner symptom.
  if (readInAt && dbPrewarnAt && readInAt > dbPrewarnAt) {
    return { removed: true };
  }

  // Post-finish removal uses the server-anchored finish — independent of
  // whatever (future-dated) value OLA wrote to results.finishTime.
  if (finishAnchor != null && now - finishAnchor > POST_FINISH_REMOVE_MS) {
    return { removed: true };
  }

  const stripe = computeStripe({
    prewarnAt: anchorAt,
    finishAt: finishAnchor,
    now,
    etaSeconds,
  });
  const removeAt =
    finishAnchor != null ? finishAnchor + POST_FINISH_REMOVE_MS : null;
  return {
    splitId: db.splitId,
    raceClassId: db.raceClassId,
    raceClassName: db.raceClassName,
    leg: db.leg,
    bib: db.bib,
    teamName: db.teamName ?? "",
    prewarnAt: anchorAt,
    finishAt: finishAnchor,
    removeAt,
    etaSeconds,
    stripe,
  };
}

function recomputeStripe(row, now) {
  if (row.finishAt != null && now - row.finishAt > POST_FINISH_REMOVE_MS) {
    return { ...row, removed: true };
  }
  const stripe = computeStripe({
    prewarnAt: row.prewarnAt,
    finishAt: row.finishAt,
    now,
    etaSeconds: row.etaSeconds,
  });
  return stripe === row.stripe ? row : { ...row, stripe };
}

function computeStripe({ prewarnAt, finishAt, now, etaSeconds }) {
  if (finishAt) return "red";
  if (!prewarnAt) return "green";
  const elapsed = now - prewarnAt;
  if (elapsed >= GREEN_MS) return "yellow";
  // Also flip to YELLOW when the countdown is within 90 s of ETA — for
  // short legs that's earlier than the elapsed-time rule, for long legs
  // it's later (so the elapsed rule wins).
  const remaining = (etaSeconds ?? DEFAULT_ETA_S) * 1000 - elapsed;
  if (remaining <= YELLOW_REMAINING_MS) return "yellow";
  return "green";
}

function rowEqualForUI(a, b) {
  return (
    a.stripe === b.stripe &&
    a.bib === b.bib &&
    a.teamName === b.teamName &&
    a.leg === b.leg &&
    a.prewarnAt === b.prewarnAt &&
    a.finishAt === b.finishAt &&
    a.removeAt === b.removeAt &&
    a.etaSeconds === b.etaSeconds
  );
}

function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function durationSeconds(a, b) {
  const ax = toMs(a);
  const bx = toMs(b);
  if (ax == null || bx == null) return null;
  return Math.round((bx - ax) / 1000);
}

function average(arr) {
  if (arr.length === 0) return DEFAULT_ETA_S;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}
