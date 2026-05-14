// SSE broker. Internal channels are keyed by raceClassId — that's what the
// poll loop emits. A single client can subscribe to MULTIPLE raceClassId
// channels at once (used when the dropdown selection is a "class group" that
// covers all relay legs of an event class).
//
// Every outgoing data: event is auto-stamped with `serverNow` (epoch ms).
// The client uses this to maintain a clock-offset (serverNow - Date.now())
// so the countdown stays accurate even when the browser/PC clock is not
// synced to the database/server clock. A periodic `hb` event keeps that
// offset fresh during long quiet periods between diffs.
//
// Wire format (each `data:` line is JSON):
//   { "type": "snapshot", "rows": [...], "failover": false, "serverNow": ms }
//   { "type": "diff", "added|updated|removed": [row], "failover": false, "serverNow": ms }
//   { "type": "failover", "active": true, "serverNow": ms }
//   { "type": "classes", "classes": [{id, name}], "serverNow": ms }
//   { "type": "hb", "serverNow": ms }

import { logger } from "./log.js";

const log = logger("sse");

export class SseBroker {
  constructor() {
    this.channels = new Map(); // raceClassId -> Set(client)
    this.lobby = new Set();    // clients without a class yet (still see "classes")
  }

  // channelKeys: null/undefined/empty => lobby. Otherwise an array of
  // raceClassIds this client wants to receive diffs for.
  attach(req, res, channelKeys) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const keys = Array.isArray(channelKeys) ? [...new Set(channelKeys)] : [];
    const client = { res, channelKeys: keys };

    if (keys.length === 0) {
      this.lobby.add(client);
    } else {
      for (const k of keys) {
        let set = this.channels.get(k);
        if (!set) this.channels.set(k, (set = new Set()));
        set.add(client);
      }
    }

    const heartbeat = setInterval(() => {
      try {
        // ": ping" keeps the TCP socket alive (comment, invisible to JS).
        // The "hb" data event keeps the client's serverNow offset fresh.
        res.write(": ping\n\n");
        this.send(client, { type: "hb" });
      } catch {
        // ignore
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (keys.length === 0) {
        this.lobby.delete(client);
      } else {
        for (const k of keys) this.channels.get(k)?.delete(client);
      }
      log.debug(
        `SSE client disconnected (channels=${keys.length === 0 ? "lobby" : keys.join(",")})`,
      );
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    return client;
  }

  send(client, payload) {
    try {
      const enriched = { ...payload, serverNow: Date.now() };
      client.res.write(`data: ${JSON.stringify(enriched)}\n\n`);
    } catch {
      // socket likely closed; cleanup handler will run.
    }
  }

  broadcast(raceClassId, payload) {
    const set = this.channels.get(raceClassId);
    if (!set) return;
    for (const c of set) this.send(c, payload);
  }

  broadcastAll(payload) {
    // Each client may appear in multiple channels — dedupe before sending.
    const seen = new Set();
    for (const set of this.channels.values()) {
      for (const c of set) {
        if (seen.has(c)) continue;
        seen.add(c);
        this.send(c, payload);
      }
    }
    for (const c of this.lobby) this.send(c, payload);
  }

  countSubscribers() {
    const seen = new Set();
    for (const set of this.channels.values()) {
      for (const c of set) seen.add(c);
    }
    return seen.size + this.lobby.size;
  }
}
