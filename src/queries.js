// SQL queries for the OLA `tiomila2026` schema.
//
// All schema confirmed against DESCRIBE output for: splittimes / results /
// rawdatafromelectronicpunchingcards / entries / raceclasses /
// raceclasssplittimecontrols / eventclasses.
//
// eventclasses notes:
//   - Canonical class name lives in `eventclasses.name` (varchar(50)).
//     This is what the dropdown displays.
//   - `eventClassId` is its PK and the FK target from raceclasses.
//
// raceclasssplittimecontrols notes:
//   - Composite PK (raceClassId, splitTimeControlId, ordered).
//   - The same splitTimeControlId can appear under multiple raceClasses,
//     so the membership check must anchor on raceClassId in addition to
//     the control id.
//   - We use EXISTS (not INNER JOIN) so that a control configured with
//     multiple `ordered` rows for the same raceClassId does not multiply
//     splittime rows in the result set.
//   - splittimes.timingControl is the FK pointing to splitTimeControlId.
//   - `name = 'Prewarning'` filters down to forvarning controls.
//
// raceclasses notes:
//   - `raceclasses.raceClassName` is per-leg ("Herrkavlen 1") and ONLY used
//     for debug context — the UI dropdown uses eventclasses.name instead.
//   - `relayLeg` is on the raceclass row itself, so for a relay each leg is a
//     SEPARATE raceClassId sharing `eventClassId`. We use `raceclasses.relayLeg`
//     as the authoritative leg for the UI badge — `results.relayPersonOrder`
//     should match it.
//   - Because raceClassId already partitions by leg, the rolling-median ETA
//     is keyed by raceClassId alone (no separate leg dimension needed).
//
// Key column mappings:
//   splittimes — composite PK
//     (resultRaceIndividualNumber, timingControl, passedCount)
//     splittimes.resultRaceIndividualNumber  → results.resultId  (FK
//        SplitTimes_FK00; the column name is misleading — despite saying
//        "individual number" the FK target is the result PK, NOT
//        results.raceStartNumber).
//     splittimes.timingControl               → raceclasssplittimecontrols.splitTimeControlId
//     splittimes.passedTime, modifyDate
//
//   results
//     resultId                  PK — FK target from splittimes
//     raceStartNumber           — bib-equivalent assigned at start; NOT
//                                 used in any join here
//     bibNumber                 — varchar; what we display
//     raceClassId               → raceclasses.raceClassId
//     entryId                   → entries.entryId
//     relayPersonOrder          — RELAY LEG (1, 2, 3, …); NULL for individual races
//     finishTime                — datetime(3)
//     rawDataFromElectronicPunchingCardsId  → rawdatafromelectronicpunchingcards.ID
//     bibNumber, runnerStatus, modifyDate
//
//   rawdatafromelectronicpunchingcards
//     ID                        PK (NOTE: capital ID, not rawDataId)
//     readInTime                — datetime
//     modifyDate                — varchar(23) (string compare works for ISO format)
//
//   entries
//     entryId                   PK
//     teamName                  varchar(100)
//     bibNumber                 varchar(10) (fallback if results.bibNumber NULL)
//
// We expose a synthetic `splitId` to the UI as
//   "<resultRaceIndividualNumber>-<timingControl>-<passedCount>"
// so the rest of the pipeline can keep using a single string id.
//
// readInTime detection: when a card is read, OLA updates results
// (FK rawDataFromElectronicPunchingCardsId is touched), so results.modifyDate
// fires. We therefore poll on splittimes.modifyDate OR results.modifyDate
// only — no need to scan rawdata.modifyDate (which is varchar anyway).

export const QUERIES = {
  // One row per (eventClassId × raceClassId). The Store collapses the rows
  // into one group per eventClassId, using `eventclasses.name` as the
  // canonical display name and collecting all child raceClassIds for the
  // SSE channel subscription. INNER JOIN: an event class with no raceclasses
  // is useless for prewarning, so don't show it in the dropdown.
  classes: `
    SELECT
      ec.eventClassId AS eventClassId,
      ec.name         AS name,
      rc.raceClassId  AS raceClassId,
      rc.relayLeg     AS relayLeg
    FROM eventclasses ec
    INNER JOIN raceclasses rc
      ON rc.eventClassId = ec.eventClassId
    ORDER BY ec.name ASC, rc.relayLeg ASC
  `,

  // All Prewarning passings + enriched metadata. Returns only rows whose
  // splittime OR result row changed since :since, so the diff stays cheap.
  prewarningSince: `
    SELECT
      CONCAT(st.resultRaceIndividualNumber, '-', st.timingControl, '-', st.passedCount)
                                AS splitId,
      st.resultRaceIndividualNumber AS raceIndividualNumber,
      st.timingControl          AS timingControl,
      st.passedCount            AS passedCount,
      st.passedTime             AS prewarnAt,
      st.modifyDate             AS stModifyDate,
      r.resultId                AS resultId,
      r.raceClassId             AS raceClassId,
      rc.eventClassId           AS eventClassId,
      rc.raceClassName          AS raceClassName,
      rc.relayLeg               AS leg,
      COALESCE(r.bibNumber, e.bibNumber) AS bib,
      r.finishTime              AS finishTime,
      r.runnerStatus            AS runnerStatus,
      r.modifyDate              AS resModifyDate,
      e.teamName                AS teamName,
      raw.readInTime            AS readInTime
    FROM splittimes st
    INNER JOIN results r
      ON r.resultId = st.resultRaceIndividualNumber
    INNER JOIN raceclasses rc
      ON rc.raceClassId = r.raceClassId
    LEFT JOIN entries e
      ON e.entryId = r.entryId
    LEFT JOIN rawdatafromelectronicpunchingcards raw
      ON raw.ID = r.rawDataFromElectronicPunchingCardsId
    WHERE EXISTS (
            SELECT 1
            FROM raceclasssplittimecontrols c
            WHERE c.raceClassId       = r.raceClassId
              AND c.splitTimeControlId = st.timingControl
              AND c.name = 'Prewarning'
          )
      AND (st.modifyDate > ? OR r.modifyDate > ?)
    ORDER BY st.passedTime ASC
  `,

  // ETA seed: completed runners (finishTime IS NOT NULL) we already have a
  // Prewarning passing for. Keyed by raceClassId — each leg is its own
  // raceClassId so this implicitly partitions per leg.
  finishedSamples: `
    SELECT
      st.passedTime  AS prewarnAt,
      r.finishTime   AS finishTime
    FROM splittimes st
    INNER JOIN results r
      ON r.resultId = st.resultRaceIndividualNumber
    WHERE r.raceClassId = ?
      AND r.finishTime IS NOT NULL
      AND EXISTS (
            SELECT 1
            FROM raceclasssplittimecontrols c
            WHERE c.raceClassId       = r.raceClassId
              AND c.splitTimeControlId = st.timingControl
              AND c.name = 'Prewarning'
          )
    ORDER BY r.finishTime ASC
    LIMIT 50
  `,
};

export const SQL_EPOCH = "1970-01-01 00:00:00";
