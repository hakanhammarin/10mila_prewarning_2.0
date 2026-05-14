// Prewarning simulator. Drives the state machine end-to-end against a real
// MySQL DB so you can see GREEN -> YELLOW -> RED -> removed on screen.
//
// Reuses config.yml from the main app so DB credentials stay in one place.
// Talks directly to mysql2 (no failover wrapper) — the simulator is a
// human-driven CLI tool and a single connection is enough.
//
// IDENTIFIER NOTE
// ===============
// The splittimes.resultRaceIndividualNumber column is FK'd to
// results.resultId (per FK SplitTimes_FK00) — despite its misleading name
// it is NOT a start number. So everywhere a runner is referenced, this
// tool takes a `resultId` (the integer PK from the results table). The
// raceStartNumber column on results is a separate, prewarning-irrelevant
// field used by the rest of OLA's start-line workflow.
//
// Usage:
//   node src/simulate.js <command> [args]
//
// Commands:
//   list-classes [--limit N]
//   list-runners <raceClassId> [--limit N]
//   prep         <resultId>
//   prewarn      <splitTimeControlId> <resultId>
//   finish       <resultId>
//   readin       <resultId>
//   force-remove <resultId>
//   cleanup      <splitTimeControlId> <resultId>
//   demo         <bibNumber> <legNumber>
//                [--class <name>] [--green-secs N] [--red-secs N] [--no-prep]

import mysql from "mysql2/promise";
import { loadConfig } from "./config.js";

const COMMANDS = {
  "list-classes": listClasses,
  "list-runners": listRunners,
  "prep": prep,
  "prewarn": prewarn,
  "finish": finish,
  "readin": readin,
  "force-remove": forceRemove,
  "cleanup": cleanup,
  "demo": demo,
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}\n`);
    printUsage();
    process.exit(1);
  }

  const cfg = loadConfig();
  const conn = await mysql.createConnection({
    host: cfg.mysql.primary.host,
    port: cfg.mysql.primary.port || 3306,
    user: cfg.mysql.primary.user,
    password: cfg.mysql.primary.password,
    database: cfg.mysql.primary.database,
    charset: "utf8mb4",
    // Match db.js: OLA's DATETIMEs are stored in the DB server's local TZ
    // (Europe/Stockholm), so we want mysql2 to interpret them in this
    // process's local TZ. With "Z" the parsed Date is ~2h in the future
    // and the prewarning countdown would show 122-ish minutes.
    timezone: "local",
    dateStrings: false,
  });

  try {
    await handler(conn, parseArgs(argv.slice(1)));
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});

// ---- commands ----------------------------------------------------------

async function listClasses(conn, { flags }) {
  const limit = clampLimit(flags.limit, 50);
  const [rows] = await conn.query(
    `SELECT rc.raceClassId,
            ec.name        AS className,
            rc.relayLeg,
            c.splitTimeControlId
     FROM raceclasses rc
     INNER JOIN eventclasses ec ON ec.eventClassId = rc.eventClassId
     INNER JOIN raceclasssplittimecontrols c
       ON c.raceClassId = rc.raceClassId
      AND c.name = 'Prewarning'
     ORDER BY ec.name ASC, rc.relayLeg ASC
     LIMIT ${limit}`,
  );
  if (rows.length === 0) {
    console.log("No raceclasses with a Prewarning control found.");
    return;
  }
  console.table(rows);
  console.log(
    `Pick a (raceClassId, splitTimeControlId) pair, then 'list-runners <raceClassId>'.`,
  );
}

async function listRunners(conn, { positional, flags }) {
  const rc = requireInt(positional[0], "raceClassId");
  const limit = clampLimit(flags.limit, 10);
  const [rows] = await conn.query(
    `SELECT r.resultId,
            r.bibNumber,
            e.teamName,
            r.finishTime,
            r.runnerStatus,
            r.rawDataFromElectronicPunchingCardsId AS rawId
     FROM results r
     LEFT JOIN entries e ON e.entryId = r.entryId
     WHERE r.raceClassId = ?
     ORDER BY r.resultId
     LIMIT ${limit}`,
    [rc],
  );
  if (rows.length === 0) {
    console.log(`No result rows in raceClassId=${rc}.`);
    return;
  }
  console.table(rows);
  const stale = rows.filter(
    (r) => r.finishTime != null || r.rawId != null,
  ).length;
  if (stale > 0) {
    console.log(
      `\n${stale} of ${rows.length} runner(s) have finishTime or readInTime ` +
        `from a previous race. Run 'prep <resultId>' to clear before testing.`,
    );
  }
}

// Make a result row ready for prewarning testing in one shot:
//   - clear results.finishTime         (often set from a previous test/replay)
//   - clear rawdata.readInTime on the linked rawdata row (would otherwise
//     cause the prewarning display to remove the row immediately on load).
// Does NOT touch raceStartNumber — that column is irrelevant to prewarning.
async function prep(conn, { positional }) {
  const resultId = requireInt(positional[0], "resultId");

  const [rows] = await conn.query(
    `SELECT resultId, raceClassId, bibNumber, finishTime,
            rawDataFromElectronicPunchingCardsId AS rawId
     FROM   results
     WHERE  resultId = ?`,
    [resultId],
  );
  if (rows.length === 0) {
    throw new Error(`No result row with resultId=${resultId}`);
  }
  const r = rows[0];

  await conn.query(
    `UPDATE results
     SET    finishTime = NULL,
            modifyDate = NOW(3)
     WHERE  resultId = ?`,
    [resultId],
  );

  let rawAction;
  if (r.rawId != null) {
    const [u] = await conn.query(
      `UPDATE rawdatafromelectronicpunchingcards
       SET    readInTime = NULL
       WHERE  ID = ?`,
      [r.rawId],
    );
    rawAction = u.affectedRows > 0
      ? `cleared readInTime on rawId=${r.rawId}`
      : `no rawdata row found for rawId=${r.rawId}`;
  } else {
    rawAction = `no linked rawdata row (rawId IS NULL)`;
  }

  const hadFinish = r.finishTime != null;
  console.log(
    `prep: resultId=${resultId} class=${r.raceClassId} bib=${r.bibNumber}\n` +
      `      ${hadFinish ? "cleared finishTime" : "finishTime was already NULL"}\n` +
      `      ${rawAction}\n`,
  );
}

async function prewarn(conn, { positional }) {
  const ctrl = requireInt(positional[0], "splitTimeControlId");
  const resultId = requireInt(positional[1], "resultId");

  const meta = await getResultMeta(conn, resultId);
  await assertPrewarnControl(conn, meta.raceClassId, ctrl);

  // UPSERT: re-running prewarn refreshes the splittime to "now" so the
  // GREEN-stripe timer restarts. Useful for re-testing without cleanup.
  const [r] = await conn.query(
    `INSERT INTO splittimes
       (resultRaceIndividualNumber, timingControl, passedTime,
        splitTime, passedCount, modifyDate)
     VALUES (?, ?, NOW(), 0, 1, NOW(3))
     ON DUPLICATE KEY UPDATE
       passedTime = NOW(),
       modifyDate = NOW(3)`,
    [resultId, ctrl],
  );
  // affectedRows is 1 for INSERT, 2 for UPDATE in mysql2 with ON DUPLICATE KEY.
  const action = r.affectedRows === 1 ? "inserted" : "refreshed";
  console.log(
    `prewarn: ${action} splittime resultId=${resultId} ` +
      `class=${meta.raceClassId} ctrl=${ctrl} passedCount=1\n` +
      `         row should appear on screen with GREEN stripe within 1–2 s.`,
  );
}

async function finish(conn, { positional }) {
  const resultId = requireInt(positional[0], "resultId");
  const [r] = await conn.query(
    `UPDATE results
     SET    finishTime = NOW(3),
            modifyDate = NOW(3)
     WHERE  resultId = ?`,
    [resultId],
  );
  if (r.affectedRows === 0) {
    throw new Error(`No result row with resultId=${resultId}`);
  }
  console.log(
    `finish: set finishTime on resultId=${resultId} → stripe should turn RED.`,
  );
}

async function readin(conn, { positional }) {
  const resultId = requireInt(positional[0], "resultId");

  const [check] = await conn.query(
    `SELECT rawDataFromElectronicPunchingCardsId AS rawId
     FROM   results
     WHERE  resultId = ?`,
    [resultId],
  );
  if (check.length === 0) {
    throw new Error(`No result row with resultId=${resultId}`);
  }
  if (check[0].rawId == null) {
    console.log(
      `readin: resultId=${resultId} has no rawdata row (rawId IS NULL). ` +
        `Use 'force-remove' instead to trigger fallback removal.`,
    );
    return;
  }

  const [r] = await conn.query(
    `UPDATE rawdatafromelectronicpunchingcards
     SET    readInTime = NOW()
     WHERE  ID = ?`,
    [check[0].rawId],
  );
  if (r.affectedRows === 0) {
    console.log(
      `readin: rawId=${check[0].rawId} not found in rawdata table. ` +
        `Use 'force-remove' instead.`,
    );
    return;
  }

  // Bump results.modifyDate so the poller's WHERE picks the change up
  // (rawdata.modifyDate is varchar(23) and intentionally not polled).
  await conn.query(
    `UPDATE results
     SET    modifyDate = NOW(3)
     WHERE  resultId = ?`,
    [resultId],
  );

  console.log(
    `readin: set readInTime on rawId=${check[0].rawId} for resultId=${resultId} ` +
      `→ row should slide off within 1–2 polls.`,
  );
}

async function forceRemove(conn, { positional }) {
  const resultId = requireInt(positional[0], "resultId");

  // 60 s past now; state.js fallback removes at finishTime + POST_FINISH_REMOVE_MS
  // (30 s currently). 60 s gives a safety margin so the fallback is
  // unambiguously past-due on the very next poll.
  const [r] = await conn.query(
    `UPDATE results
     SET    finishTime = DATE_SUB(NOW(3), INTERVAL 60 SECOND),
            modifyDate = NOW(3)
     WHERE  resultId = ?`,
    [resultId],
  );
  if (r.affectedRows === 0) {
    throw new Error(`No result row with resultId=${resultId}`);
  }
  console.log(
    `force-remove: set finishTime to 60 s ago on resultId=${resultId} → ` +
      `fallback removal triggers on next poll.`,
  );
}

async function cleanup(conn, { positional }) {
  const ctrl = requireInt(positional[0], "splitTimeControlId");
  const resultId = requireInt(positional[1], "resultId");

  const [del] = await conn.query(
    `DELETE FROM splittimes
     WHERE  resultRaceIndividualNumber = ?
       AND  timingControl = ?
       AND  passedCount   = 1`,
    [resultId, ctrl],
  );
  const [upd] = await conn.query(
    `UPDATE results
     SET    finishTime = NULL,
            modifyDate = NOW(3)
     WHERE  resultId = ?`,
    [resultId],
  );
  console.log(
    `cleanup: deleted ${del.affectedRows} splittime row(s), ` +
      `reset finishTime on ${upd.affectedRows} result row(s).`,
  );
  console.log(
    `         (rawdata.readInTime is NOT rolled back — re-run 'prep' if needed.)`,
  );
}

async function demo(conn, { positional, flags }) {
  if (!positional[0]) throw new Error("Missing argument: bibNumber");
  const bib = String(positional[0]);
  const leg = requireInt(positional[1], "legNumber");
  const className = flags.class ? String(flags.class) : null;

  const resolved = await resolveBibLeg(conn, bib, leg, className);
  const resultId = resolved.resultId;
  const ctrl = resolved.splitTimeControlId;
  // Defaults match the state machine in src/state.js:
  //   GREEN_MS = 70s, POST_FINISH_REMOVE_MS = 30s.
  // green-secs > 70 lets the user actually see the GREEN→YELLOW flip
  // before we trigger finish. red-secs < 30 keeps the post-finish fallback
  // removal out of the picture so readin (or force-remove) is what does
  // the work — otherwise the row vanishes via the 30 s timer instead.
  const greenSecs = clampSecs(flags["green-secs"], 90, 5, 300);
  const redSecs = clampSecs(
    flags["red-secs"] ?? flags["yellow-secs"], // accept the old name too
    20,
    1,
    120,
  );

  console.log(
    `\n=== demo: ${resolved.className} leg ${resolved.relayLeg} ` +
      `· bib ${resolved.bibNumber} · team "${resolved.teamName ?? ""}" ===\n` +
      `      → resultId=${resultId} class=${resolved.raceClassId} ctrl=${ctrl}\n`,
  );

  // Run prep unless the user explicitly opts out. Without it, a runner
  // with leftover finishTime / readInTime from a previous race would
  // either render as RED immediately or get filtered out at load time
  // by the prewarning display, defeating the demo.
  if (flags["no-prep"]) {
    console.log(`(1/5) PREP — skipped (--no-prep)`);
  } else {
    console.log(`(1/5) PREP — clear leftover finishTime / readInTime`);
    await prep(conn, { positional: [resultId], flags: {} });
  }

  console.log(`(2/5) PREWARN — runner appears with GREEN stripe + 3:00 countdown`);
  await prewarn(conn, { positional: [ctrl, resultId], flags: {} });

  console.log(
    `\n(3/5) Waiting ${greenSecs} s — GREEN for first 70 s (or until ` +
      `countdown hits 90 s), then YELLOW.`,
  );
  await sleep(greenSecs * 1000);

  console.log(`\n(4/5) FINISH — stripe goes RED`);
  await finish(conn, { positional: [resultId], flags: {} });

  console.log(
    `\n      Waiting ${redSecs} s with RED visible (countdown 0:30→0:00; ` +
      `auto-removes at 30 s if we don't trigger readin first)…`,
  );
  await sleep(redSecs * 1000);

  if (resolved.rawId == null) {
    console.log(`\n(5/5) READIN — no rawdata row → using fallback`);
    await forceRemove(conn, { positional: [resultId], flags: {} });
  } else {
    console.log(`\n(5/5) READIN — row slides off`);
    await readin(conn, { positional: [resultId], flags: {} });
  }

  console.log(
    `\n=== demo done. Run 'cleanup ${ctrl} ${resultId}' to reset. ===\n`,
  );
}

// ---- helpers -----------------------------------------------------------

// Resolve a (bib, leg) pair (with optional class filter) to the underlying
// resultId, raceClassId, and Prewarning splitTimeControlId. Throws helpful
// errors on no-match or ambiguous-match.
async function resolveBibLeg(conn, bib, leg, className) {
  let sql = `
    SELECT r.resultId,
           r.raceClassId,
           ec.name        AS className,
           rc.relayLeg,
           e.teamName,
           COALESCE(r.bibNumber, e.bibNumber) AS bibNumber,
           r.rawDataFromElectronicPunchingCardsId AS rawId
    FROM   results r
    INNER JOIN raceclasses rc
      ON rc.raceClassId = r.raceClassId
    INNER JOIN eventclasses ec
      ON ec.eventClassId = rc.eventClassId
    LEFT JOIN entries e
      ON e.entryId = r.entryId
    WHERE COALESCE(r.bibNumber, e.bibNumber) = ?
      AND rc.relayLeg = ?
  `;
  const params = [bib, leg];
  if (className) {
    sql += ` AND ec.name = ?`;
    params.push(className);
  }
  sql += ` LIMIT 5`;

  const [rows] = await conn.query(sql, params);
  if (rows.length === 0) {
    throw new Error(
      `No runner found for bib=${bib} leg=${leg}` +
        (className ? ` in class "${className}"` : "") +
        `.\nUse 'list-classes' to see what's defined, then ` +
        `'list-runners <raceClassId>' to find valid bib numbers.`,
    );
  }
  if (rows.length > 1) {
    const classes = [...new Set(rows.map((r) => r.className))].join(", ");
    throw new Error(
      `Multiple runners match bib=${bib} leg=${leg} across classes: ` +
        `${classes}. Disambiguate with --class "<name>".`,
    );
  }
  const r = rows[0];

  // Look up the Prewarning control for the resolved raceClass. We do this
  // in a second query (rather than joining above) so the bib+leg lookup
  // doesn't multiply rows when a raceClass has multiple Prewarning entries.
  const [ctrls] = await conn.query(
    `SELECT splitTimeControlId
     FROM   raceclasssplittimecontrols
     WHERE  raceClassId = ?
       AND  name        = 'Prewarning'
     ORDER BY splitTimeControlId
     LIMIT 1`,
    [r.raceClassId],
  );
  if (ctrls.length === 0) {
    throw new Error(
      `${r.className} leg ${r.relayLeg} (raceClassId=${r.raceClassId}) ` +
        `has no Prewarning control defined in raceclasssplittimecontrols.`,
    );
  }
  r.splitTimeControlId = ctrls[0].splitTimeControlId;
  return r;
}

async function getResultMeta(conn, resultId) {
  const [rows] = await conn.query(
    `SELECT resultId, raceClassId, bibNumber,
            rawDataFromElectronicPunchingCardsId AS rawId
     FROM   results
     WHERE  resultId = ?`,
    [resultId],
  );
  if (rows.length === 0) {
    throw new Error(
      `No result row with resultId=${resultId}. ` +
        `Run 'list-runners <raceClassId>' to see valid resultIds.`,
    );
  }
  return rows[0];
}

async function assertPrewarnControl(conn, raceClassId, splitTimeControlId) {
  const [rows] = await conn.query(
    `SELECT 1
     FROM   raceclasssplittimecontrols
     WHERE  raceClassId       = ?
       AND  splitTimeControlId = ?
       AND  name              = 'Prewarning'
     LIMIT 1`,
    [raceClassId, splitTimeControlId],
  );
  if (rows.length === 0) {
    throw new Error(
      `splitTimeControlId=${splitTimeControlId} is not a Prewarning control ` +
        `for raceClassId=${raceClassId}. Run 'list-classes' to see valid pairs.`,
    );
  }
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next != null && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function requireInt(v, name) {
  if (v == null) throw new Error(`Missing argument: ${name}`);
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Expected positive integer for ${name}, got: ${v}`);
  }
  return n;
}

function clampLimit(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(1000, n));
}

function clampSecs(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printUsage() {
  console.log(`Usage: node src/simulate.js <command> [args]

Identifier note: this tool addresses runners by 'resultId' — the integer PK
from the results table. The splittimes FK is to results.resultId, NOT to
raceStartNumber, so resultId is what threads through every command here.

Discovery:
  list-classes [--limit 50]
      Raceclasses that have a Prewarning control defined (joined to
      eventclasses for readable class names).
  list-runners <raceClassId> [--limit 10]
      Result rows in a class, with team name, bib, and any leftover
      finishTime / readInTime from previous test runs.

Pre-test prep (run once on a runner before simulating):
  prep <resultId>
      Clears results.finishTime + rawdata.readInTime so the prewarning
      display will see the runner as fresh. Required when the DB has
      replay/test data from a previous race.

State-machine actions (drive the prewarning display manually):
  prewarn      <splitTimeControlId> <resultId>
      INSERT splittime  → row appears, GREEN stripe.
      Re-running refreshes passedTime (UPSERT) so the GREEN timer restarts.
  finish       <resultId>
      UPDATE results.finishTime  → stripe goes RED.
  readin       <resultId>
      UPDATE rawdata.readInTime  → row slides off.
      Errors out if the runner has no linked rawdata row.
  force-remove <resultId>
      Set finishTime 60 s in the past → row removed via fallback path
      (state.js POST_FINISH_REMOVE_MS = 30 s; 60 s is past the threshold).
      Use this when 'readin' has nothing to update.
  cleanup      <splitTimeControlId> <resultId>
      DELETE the splittime + NULL out finishTime so the runner is back
      at start. (Does NOT roll back rawdata.readInTime — re-run prep.)

End-to-end (the easy form — bib + leg, everything else auto-resolved):
  demo <bibNumber> <legNumber>
       [--class <name>] [--green-secs 90] [--red-secs 20] [--no-prep]
      Resolves bib + leg to (resultId, raceClassId) and looks up the
      Prewarning splitTimeControlId for that raceClass automatically.
      Then runs: prep → prewarn → wait (GREEN→YELLOW at 70 s) → finish
      → wait (RED with 30 s post-finish countdown) → readin/force-remove.

      --class disambiguates when the same bib + leg pair exists in
      multiple event classes. Skip --no-prep unless you've already
      prepped manually.

      Defaults walk through every color: GREEN for ~70 s, then YELLOW
      for ~20 s, then RED with countdown 0:30→0:10, then readin removes
      the row.

Typical workflow:
  npm run simulate -- list-classes              # see classes + legs
  npm run simulate -- list-runners 28           # pick a bib (and note resultId)
  npm run simulate -- demo 563 1                # auto-preps & resolves ctrl
  # demo prints the resolved ctrl + resultId; use them for cleanup:
  npm run simulate -- cleanup 202 13012         # reset for next test`);
}
