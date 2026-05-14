// Build a fast-realtime sf_replay.txt for live OLA / SimOLA simulation.
//
// Reads ./SimOLA/sf_replay.txt as a template and rewrites it so:
//   * every inter-punch gap is capped at MAX_GAP_S (30 s by default), so
//     the field rips through the course at simulator-speed instead of
//     real race-pace,
//   * the prewarn → finish gap is preserved exactly as in the template
//     (prewarn = last control punch immediately before FINISH/control=4),
//   * each runner's FINISH delta is preserved → the absolute finish-time
//     distribution across the field matches the source file,
//   * any trailing punches after FINISH (readout etc.) are bumped down to
//     a 30 s cap as well.
//
// Output:
//   reference line set to "now" in HH:MM:SS
//   filename: SimOLA/sf_replay_YYYY-MM-DD_HH:MM:SS.txt (where the time
//     portion is "now" — colons match the user's requested format).
//
// Usage:
//   node src/build-sf-replay.js
//
// Optional env flags:
//   SF_REPLAY_INPUT   override template path
//   SF_REPLAY_OUTDIR  override output directory
//   SF_REPLAY_MAX_GAP override per-punch cap in seconds (integer)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const TEMPLATE =
  process.env.SF_REPLAY_INPUT ?? path.join(root, "SimOLA", "sf_replay.txt");
const OUTPUT_DIR =
  process.env.SF_REPLAY_OUTDIR ?? path.join(root, "SimOLA");
const MAX_GAP_S = Number(process.env.SF_REPLAY_MAX_GAP ?? 30);
const FINISH_CONTROL = 4;

function main() {
  if (!Number.isFinite(MAX_GAP_S) || MAX_GAP_S <= 0) {
    throw new Error(`SF_REPLAY_MAX_GAP must be a positive number, got: ${MAX_GAP_S}`);
  }
  if (!fs.existsSync(TEMPLATE)) {
    throw new Error(`Template not found: ${TEMPLATE}`);
  }
  const src = fs.readFileSync(TEMPLATE, "utf8");
  const { events } = parse(src);

  // Group by sicard in first-appearance order so the output keeps the
  // template's runner-by-runner layout. Within each group, events sort
  // by original deltatime so the punch chronology is preserved before
  // we rewrite the deltas.
  const byCard = new Map();
  for (const e of events) {
    if (!byCard.has(e.sicard)) byCard.set(e.sicard, []);
    byCard.get(e.sicard).push(e);
  }

  const remapped = [];
  let skippedNoFinish = 0;
  let skippedFinishFirst = 0;

  for (const [sicard, evs] of byCard) {
    evs.sort((a, b) => a.delta - b.delta);

    const finishIdx = evs.findIndex((e) => e.control === FINISH_CONTROL);
    if (finishIdx < 0) {
      // No finish punch → no useful prewarn→finish gap to preserve.
      // Skip rather than emit a half-runner that can never turn RED.
      skippedNoFinish++;
      continue;
    }
    if (finishIdx === 0) {
      // FINISH is the first punch — nothing reasonable to call a "prewarn".
      skippedFinishFirst++;
      continue;
    }

    const orig = evs.map((e) => e.delta);
    const newDelta = new Array(evs.length);

    // Anchor: keep this runner's FINISH at the same deltatime as the
    // template so the field-wide finish distribution survives the rewrite.
    newDelta[finishIdx] = orig[finishIdx];

    // Preserve the prewarn → finish delta exactly. prewarn = the punch
    // immediately before FINISH for this SI card. That makes the prewarn
    // delta also unchanged (it's anchored backward from the preserved finish).
    const prewarnIdx = finishIdx - 1;
    const prewarnFinishDelta = orig[finishIdx] - orig[prewarnIdx];
    newDelta[prewarnIdx] = newDelta[finishIdx] - prewarnFinishDelta;

    // Walk backwards from prewarn, capping each consecutive gap at MAX_GAP_S.
    for (let i = prewarnIdx - 1; i >= 0; i--) {
      const origGap = orig[i + 1] - orig[i];
      const cappedGap = Math.min(origGap, MAX_GAP_S);
      newDelta[i] = newDelta[i + 1] - cappedGap;
    }
    // Walk forwards from finish for trailing punches (e.g. control 10 readout).
    for (let i = finishIdx + 1; i < evs.length; i++) {
      const origGap = orig[i] - orig[i - 1];
      const cappedGap = Math.min(origGap, MAX_GAP_S);
      newDelta[i] = newDelta[i - 1] + cappedGap;
    }

    for (let i = 0; i < evs.length; i++) {
      remapped.push({
        delta: newDelta[i],
        sicard,
        control: evs[i].control,
      });
    }
  }

  const now = new Date();
  const refTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (!fs.existsSync(OUTPUT_DIR)) {
    throw new Error(`Output directory not found: ${OUTPUT_DIR}`);
  }
  const outFile = path.join(OUTPUT_DIR, `sf_replay_${stamp}.txt`);

  const lines = [
    "#reference time",
    `reference\t${refTime}`,
    "#deltatime\tsicard\tcontrol",
  ];
  for (const e of remapped) {
    lines.push(`${e.delta}\t${e.sicard}\t${e.control}`);
  }
  fs.writeFileSync(outFile, lines.join("\n") + "\n");

  console.log(`Wrote ${outFile}`);
  console.log(
    `  reference=${refTime}  cards=${byCard.size}  events=${remapped.length}` +
      `  cap=${MAX_GAP_S}s`,
  );
  if (skippedNoFinish || skippedFinishFirst) {
    console.log(
      `  skipped: ${skippedNoFinish} cards without FINISH,` +
        ` ${skippedFinishFirst} with FINISH as first punch`,
    );
  }
}

function parse(src) {
  const headerLines = [];
  let refTime = null;
  const events = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith("#")) {
      headerLines.push(line);
      continue;
    }
    const parts = line.split(/\t/);
    if (parts[0] === "reference") {
      refTime = parts[1];
      continue;
    }
    if (parts.length < 3) continue;
    const [delta, sicard, control] = parts;
    const d = Number(delta);
    const c = Number(control);
    if (!Number.isFinite(d) || !Number.isFinite(c)) continue;
    // sicard is kept as a raw string — SI numbers can be long and we don't
    // want JS number-precision quirks if they ever exceed 2^53.
    events.push({ delta: d, sicard, control: c });
  }
  return { headerLines, refTime, events };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

main();
