// In-memory state per (raceClassId, splitId).
//
// State machine:
//   prewarn punched         -> GREEN
//     green_s elapsed                   \
//     OR <=yellow_remaining_s remaining  } -> YELLOW   (yellow_mode=time)
//     OR last-checkpoint punched         } -> YELLOW   (yellow_mode=checkpoint)
//   finishTime set          -> RED, post_finish_remove_s countdown shown
//   post_finish_remove_s elapsed  -> remove
//
// readInTime is observed but NOT a removal trigger — the POST_FINISH
// timer is the only thing that removes rows. We tried using readout as
// a remove trigger but SimOLA fast-replay collapses prewarn/finish/
// readout into a single poll, making fresh vs stale indistinguishable.
//
// Countdown anchor: `prewarnAt` on a stored row is the SERVER's wall clock
// at the moment the row was first observed — NOT the DB's `passedTime`.
// `finishAt` likewise anchors to the server's now-time the first time we
// observed `results.finishTime` set on this row. `lastCheckpointAt` is the
// server time the first time we saw a splittime with the configured
// last-checkpoint control. All three anchors are locked on first
// observation and survive later poll updates.
//
// Prewarn-dwell: when a row first appears with finishTime already set
// (SimOLA fast-replay where all events arrived in one poll, or app
// restart with a runner already past finish), we PARK finishAnchor at
// `anchorAt + min_prewarn_dwell_s` so the GREEN/YELLOW phase is visible
// before transitioning to RED. In a real race finishTime arrives minutes
// after prewarn, so the dwell guard never engages.
//
// All durations come from config.state in seconds. The Store converts
// them to ms internally so its math stays in epoch-ms.
//
// Rows are keyed by splitTimeId (one Prewarning per runner per race),
// grouped by raceClassId for SSE fan-out.

// If results.modifyDate is within this many ms of splittime.modifyDate
// the prewarn and finish punches were almost certainly written in the
// same OLA write batch — typical of SimOLA fast-replay. We treat those
// rows like fresh live observations (dwell-park) regardless of how old
// the DB modifyDate is, so the row gets a visible GREEN→RED lifecycle
// instead of being filtered as "already past post-finish".
const SAME_BATCH_THRESHOLD_MS = 2_000;

export class Store {
  // cfg is the validated `state` block from config.yml:
  //   { green_s, yellow_remaining_s, post_finish_remove_s, default_eta_s,
  //     eta_sample_min_s, eta_sample_max_s, eta_sample_keep,
  //     yellow_mode: "time" | "checkpoint", last_checkpoint_control }
  constructor(cfg) {
    this.cfg = cfg;
    this._greenMs = cfg.green_s * 1000;
    this._yellowRemainingMs = cfg.yellow_remaining_s * 1000;
    this._postFinishRemoveMs = cfg.post_finish_remove_s * 1000;
    this._defaultEtaS = cfg.default_eta_s;
    this._minSampleS = cfg.eta_sample_min_s;
    this._maxSampleS = cfg.eta_sample_max_s;
    this._sampleKeep = cfg.eta_sample_keep;
    this._yellowMode = cfg.yellow_mode;
    this._minPrewarnDwellMs = (cfg.min_prewarn_dwell_s ?? 0) * 1000;

    /** raceClassId -> Map(splitId -> row) */
    this.byClass = new Map();
    /** raceClassId -> { samples: number[], etaSeconds: number } */
    this.etaByClass = new Map();
    /** eventClassId -> { id, name, raceClassIds: number[] } */
    this.groups = new Map();
  }

  get defaultEtaSeconds() {
    return this._defaultEtaS;
  }

  get yellowMode() {
    return this._yellowMode;
  }

  get lastCheckpointName() {
    return this.cfg.last_checkpoint_name;
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

    // Detect the prewarn→finish transition using the DB stamps (the only
    // thing that tells us "a finish punch just landed"), but anchor the
    // state-machine clock to the server's now-time. SimOLA replay writes
    // future-dated finishTimes; gating on `finishAt <= now` would hide
    // the finish announcement entirely.
    const dbPrewarnMs = toMs(dbRow.prewarnAt);
    const dbFinishMs = toMs(dbRow.finishTime);
    const justFinished = dbFinishMs != null && !prev?.finishAt;
    if (justFinished && dbPrewarnMs) {
      this.recordFinishedSample(raceClassId, dbPrewarnMs, dbFinishMs);
    }

    // Anchoring strategy — uses the DB's `stModifyDate` (when OLA wrote
    // the splittime) as the prewarn anchor in ALL cases. That timestamp
    // is real-clock and so works equally well for live observations
    // (~Date.now()) and back-fill after a restart (historical). The
    // state machine then derives the finish anchor from it:
    //
    //  * Same-batch write (SimOLA fast-replay, or any case where OLA
    //    wrote prewarn+finish within ~2 s): park finish at anchorAt +
    //    min_prewarn_dwell_s. A row that was prewarned N seconds ago
    //    naturally lands at the right phase — GREEN if N < dwell,
    //    RED if N >= dwell, dropped if N > dwell + post_finish_remove.
    //  * Real-race (modifyDates spread out): anchor finish at
    //    results.modifyDate (the real-clock time OLA recorded the
    //    finish). POST_FINISH window naturally drops rows past their
    //    lifecycle. This is the genuine "fast-forward to current
    //    state" path after a restart.
    const realNow = Date.now();
    const stModifyMs = toMs(dbRow.stModifyDate);
    const resModifyMs = toMs(dbRow.resModifyDate);
    const sameBatch =
      resModifyMs != null &&
      stModifyMs != null &&
      Math.abs(resModifyMs - stModifyMs) < SAME_BATCH_THRESHOLD_MS;

    const anchorAt = prev?.prewarnAt ?? stModifyMs ?? realNow;

    let finishAnchor;
    if (dbFinishMs == null) {
      finishAnchor = null;
    } else if (prev?.finishAt != null) {
      finishAnchor = prev.finishAt;
    } else if (sameBatch) {
      // Prewarn and finish were one OLA write — dwell-park from the
      // prewarn anchor so the GREEN phase plays out (or has played out,
      // for older rows; POST_FINISH then drops them).
      finishAnchor = anchorAt + this._minPrewarnDwellMs;
    } else if (resModifyMs != null) {
      // Real-race: finish written after prewarn. Anchor at the actual
      // resModifyDate. Never anchor finish before prewarn.
      finishAnchor = Math.max(resModifyMs, anchorAt);
    } else if (prev) {
      // Live transition: prev existed without finish, finish just arrived.
      finishAnchor = realNow;
    } else {
      // Defensive — finish set but no modifyDate. Fall back to dwell.
      finishAnchor = anchorAt + this._minPrewarnDwellMs;
    }
    // lastCheckpointAt is driven by recordLastCheckpoint() — not derived
    // from the prewarning query — so we just carry the previous value.
    const lastCheckpointAt = prev?.lastCheckpointAt ?? null;

    // readInTime is observed but no longer drives row removal — we used
    // to remove on fresh readout, but the SimOLA fast-replay collapses
    // readouts into the same poll as prewarn, making it impossible to
    // tell stale from fresh. Now POST_FINISH_REMOVE_MS is the sole
    // removal trigger.

    const next = this._project(dbRow, this._etaSecondsFor(raceClassId), {
      anchorAt,
      finishAnchor,
      lastCheckpointAt,
    });

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

  // Anchor lastCheckpointAt for the row matching this resultId, if any.
  // Returns { kind: "updated", raceClassId, row } on a successful anchor,
  // or null if no matching active row exists / already anchored.
  recordLastCheckpoint(resultId, observedAt = Date.now()) {
    for (const [raceClassId, map] of this.byClass) {
      for (const [splitId, row] of map) {
        if (row.resultId !== resultId) continue;
        if (row.lastCheckpointAt != null) return null;
        // Park lastCheckpointAt no earlier than `anchorAt + green_s` so
        // the GREEN phase has time to render before transitioning to
        // YELLOW. In a real race ctrl 100 fires well after green_s and
        // this is a no-op; in SimOLA fast-replay (where ctrl 100 lands
        // in the same OLA write as the prewarn) it spaces the phases.
        const minCpAnchor = row.prewarnAt + this._greenMs;
        const lastCheckpointAt = Math.max(observedAt, minCpAnchor);

        // If a finishAnchor was already parked from the prewarn poll
        // (SimOLA same-batch finish), push it out so the YELLOW phase
        // has time to render between the "Last" stamp and "Finish". Use
        // min_prewarn_dwell_s as the YELLOW duration. In a real race
        // the actual finishAt is later than this anyway, so the
        // Math.max keeps the genuine observation.
        let finishAt = row.finishAt;
        let removeAt = row.removeAt;
        if (finishAt != null) {
          const minFinishAfterCp = lastCheckpointAt + this._minPrewarnDwellMs;
          if (finishAt < minFinishAfterCp) {
            finishAt = minFinishAfterCp;
            removeAt = finishAt + this._postFinishRemoveMs;
          }
        }

        const now = Date.now();
        const refreshed = { ...row, lastCheckpointAt, finishAt, removeAt };
        refreshed.stripe = this._computeStripe({
          prewarnAt: refreshed.prewarnAt,
          finishAt: refreshed.finishAt,
          lastCheckpointAt: refreshed.lastCheckpointAt,
          now,
          etaSeconds: refreshed.etaSeconds,
        });
        map.set(splitId, refreshed);
        return { kind: "updated", raceClassId, row: refreshed };
      }
    }
    return null;
  }

  // Re-evaluate all rows against the wall clock (state transitions GREEN
  // -> YELLOW based on elapsed time, removal on finishAnchor + post_finish_remove_s).
  // Returns a list of changes.
  tick(now = Date.now()) {
    const changes = [];
    for (const [raceClassId, map] of this.byClass) {
      for (const [splitId, row] of map) {
        const refreshed = this._recompute(row, now);
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
  // [eta_sample_min_s, eta_sample_max_s] are dropped as noise/outliers.
  // The ETA switches to the average as soon as a single in-range sample
  // exists; otherwise default_eta_s stays in effect.
  setFinishedSamples(raceClassId, samples) {
    const durations = samples
      .map((s) => durationSeconds(s.prewarnAt, s.finishTime))
      .filter(
        (s) => s != null && s >= this._minSampleS && s <= this._maxSampleS,
      )
      .slice(-this._sampleKeep);
    this._setEtaFromDurations(raceClassId, durations);
  }

  // Incremental sample: called from upsertFromDb whenever a row's finishAt
  // transitions from unset to set, so the ETA tightens up live during a race
  // without waiting for the next full seed query.
  recordFinishedSample(raceClassId, prewarnAtMs, finishAtMs) {
    const dur = durationSeconds(prewarnAtMs, finishAtMs);
    if (dur == null || dur < this._minSampleS || dur > this._maxSampleS) return;
    const cur = this.etaByClass.get(raceClassId);
    const next = cur ? [...cur.samples, dur] : [dur];
    if (next.length > this._sampleKeep) {
      next.splice(0, next.length - this._sampleKeep);
    }
    this._setEtaFromDurations(raceClassId, next);
  }

  _setEtaFromDurations(raceClassId, durations) {
    const eta =
      durations.length >= 1 ? Math.round(average(durations)) : this._defaultEtaS;
    this.etaByClass.set(raceClassId, { samples: durations, etaSeconds: eta });
    const map = this.byClass.get(raceClassId);
    if (!map) return;
    for (const [splitId, row] of map) {
      if (row.etaSeconds !== eta) map.set(splitId, { ...row, etaSeconds: eta });
    }
  }

  _etaSecondsFor(raceClassId) {
    return this.etaByClass.get(raceClassId)?.etaSeconds ?? this._defaultEtaS;
  }

  // Back-compat: poll.js used to call `etaSeconds(raceClassId)`.
  etaSeconds(raceClassId) {
    return this._etaSecondsFor(raceClassId);
  }

  _project(db, etaSeconds, { anchorAt, finishAnchor, lastCheckpointAt }) {
    const now = Date.now();

    // Post-finish removal is the only removal trigger. Uses the server-
    // anchored finish — independent of whatever (future-dated) value OLA
    // wrote to results.finishTime, and independent of readInTime.
    if (finishAnchor != null && now - finishAnchor > this._postFinishRemoveMs) {
      return { removed: true };
    }

    const stripe = this._computeStripe({
      prewarnAt: anchorAt,
      finishAt: finishAnchor,
      lastCheckpointAt,
      now,
      etaSeconds,
    });
    const removeAt =
      finishAnchor != null ? finishAnchor + this._postFinishRemoveMs : null;
    return {
      splitId: db.splitId,
      resultId: db.resultId ?? null,
      raceClassId: db.raceClassId,
      raceClassName: db.raceClassName,
      leg: db.leg,
      bib: db.bib,
      teamName: db.teamName ?? "",
      prewarnAt: anchorAt,
      finishAt: finishAnchor,
      lastCheckpointAt,
      removeAt,
      etaSeconds,
      stripe,
    };
  }

  _recompute(row, now) {
    if (
      row.finishAt != null &&
      now - row.finishAt > this._postFinishRemoveMs
    ) {
      return { ...row, removed: true };
    }
    const stripe = this._computeStripe({
      prewarnAt: row.prewarnAt,
      finishAt: row.finishAt,
      lastCheckpointAt: row.lastCheckpointAt,
      now,
      etaSeconds: row.etaSeconds,
    });
    return stripe === row.stripe ? row : { ...row, stripe };
  }

  _computeStripe({ prewarnAt, finishAt, lastCheckpointAt, now, etaSeconds }) {
    // finishAt may be parked in the future when prewarn+finish arrived in
    // the same poll (SimOLA fast-replay). Treat as "not yet finished" until
    // wall clock crosses it, so the row plays through GREEN/YELLOW first.
    if (finishAt != null && finishAt <= now) return "red";
    if (!prewarnAt) return "green";

    if (this._yellowMode === "checkpoint") {
      // lastCheckpointAt may be parked at `prewarnAt + green_s` when ctrl
      // 100 was observed in the same OLA write as the prewarn. Gate on
      // `<= now` so GREEN renders until the parked moment elapses.
      const cpReached =
        lastCheckpointAt != null && lastCheckpointAt <= now;
      return cpReached ? "yellow" : "green";
    }

    // yellow_mode === "time"
    const elapsed = now - prewarnAt;
    if (elapsed >= this._greenMs) return "yellow";
    const remaining = (etaSeconds ?? this._defaultEtaS) * 1000 - elapsed;
    if (remaining <= this._yellowRemainingMs) return "yellow";
    return "green";
  }
}

function rowEqualForUI(a, b) {
  return (
    a.stripe === b.stripe &&
    a.bib === b.bib &&
    a.teamName === b.teamName &&
    a.leg === b.leg &&
    a.prewarnAt === b.prewarnAt &&
    a.finishAt === b.finishAt &&
    a.lastCheckpointAt === b.lastCheckpointAt &&
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
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}
