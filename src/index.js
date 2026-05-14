import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./config.js";
import { FailoverPool } from "./db.js";
import { Store } from "./state.js";
import { SseBroker } from "./sse.js";
import { Poller } from "./poll.js";
import { logger } from "./log.js";

const log = logger("server");
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

async function main() {
  const cfg = loadConfig();
  log.info(`Config loaded from ${cfg.__source}`);

  const db = new FailoverPool(cfg);
  const store = new Store(cfg.state);
  const broker = new SseBroker();
  const poller = new Poller({
    db,
    store,
    broker,
    intervalSeconds: cfg.poll_interval_s,
    lastCheckpointName: cfg.state.last_checkpoint_name,
    startupLookbackSeconds: cfg.state.startup_lookback_s,
  });

  db.onActiveChange((active) => {
    log.info(`DB active pool changed -> ${active}`);
    broker.broadcastAll({ type: "failover", active: active === "secondary" });
  });

  poller.start();

  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      db: db.isFailedOver() ? "secondary" : "primary",
      classes: store.groupList().length,
      sseClients: broker.countSubscribers(),
    });
  });

  app.get("/classes", (_req, res) => {
    res.json({
      classes: store.groupList(),
      failover: db.isFailedOver(),
    });
  });

  app.get("/events", (req, res) => {
    const param = (req.query.class ?? "").toString().trim();
    let group = null;
    if (param !== "") {
      group = store.resolveGroup(param);
      if (!group) {
        res.status(404).json({ error: `Unknown class: ${param}` });
        return;
      }
    }

    const channelKeys = group ? group.raceClassIds : null;
    const client = broker.attach(req, res, channelKeys);

    if (group) {
      broker.send(client, {
        type: "snapshot",
        raceClassId: group.id,
        raceClassName: group.name,
        rows: store.rowsForGroup(group),
        classes: store.groupList(),
        failover: db.isFailedOver(),
        etaConfig: { defaultS: store.defaultEtaSeconds },
      });
    } else {
      broker.send(client, {
        type: "classes",
        classes: store.groupList(),
        failover: db.isFailedOver(),
        etaConfig: { defaultS: store.defaultEtaSeconds },
      });
    }
  });

  app.use(express.static(publicDir, { extensions: ["html"] }));

  const server = app.listen(cfg.http_port, () => {
    log.info(`Listening on http://0.0.0.0:${cfg.http_port}`);
  });

  const shutdown = async (sig) => {
    log.info(`Got ${sig}, shutting down`);
    poller.stop();
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
