/**
 * Crossbench — ONE Cloudflare Worker for everything (same pattern as tongits):
 *   - serves the site from ./public via the [assets] binding
 *   - runs the API on /api/* backed by a Durable Object
 * Deploy: npx wrangler deploy
 * Routes:
 *   POST /api/results        store a result   -> { id }
 *   GET  /api/results/:id    fetch a result   -> result JSON
 *   GET  /api/stats?range=24h|7d|30d          -> [{city,country,lat,lon,down,up,ping,n}]
 * Privacy: client IP is never stored. Geo (city/lat/lon) comes from
 * Cloudflare's edge metadata, rounded to ~city precision.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*", // tighten to "https://speed.playy.online" in production
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const str = (v, len) => (typeof v === "string" ? v.slice(0, len) : null);

function sanitize(body) {
  return {
    v: 1,
    ts: Date.now(),
    down: num(body.down, 0, 100000),
    up: num(body.up, 0, 100000),
    ping: num(body.ping, 0, 10000),
    jit: num(body.jit, 0, 10000),
    isp: str(body.isp, 80),
    loc: str(body.loc, 80),
    sources: Array.isArray(body.sources)
      ? body.sources.slice(0, 12).map((s) => ({
          n: str(s.n, 30),
          ping: num(s.ping, 0, 10000),
          jit: num(s.jit, 0, 10000),
          down: num(s.down, 0, 100000),
          up: num(s.up, 0, 100000),
        }))
      : [],
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // Everything that isn't /api/* is the website itself (from ./public)
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // Attach edge geo BEFORE entering the DO (cf data only exists here)
    if (request.method === "POST" && url.pathname === "/api/results") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const rec = sanitize(body);
      if (rec.down == null) return json({ error: "no data" }, 400);
      const cf = request.cf || {};
      rec.city = str(cf.city, 60);
      rec.country = str(cf.country, 3);
      rec.lat = num(cf.latitude, -90, 90);
      rec.lon = num(cf.longitude, -180, 180);
      if (rec.lat != null) rec.lat = +rec.lat.toFixed(2); // ~city precision only
      if (rec.lon != null) rec.lon = +rec.lon.toFixed(2);

      const stub = env.SPEED_DB.get(env.SPEED_DB.idFromName("global"));
      return stub.fetch("https://do/store", { method: "POST", body: JSON.stringify(rec) });
    }

    const stub = env.SPEED_DB.get(env.SPEED_DB.idFromName("global"));
    if (url.pathname.startsWith("/api/results/")) {
      const id = url.pathname.split("/")[3] || "";
      return stub.fetch("https://do/get?id=" + encodeURIComponent(id));
    }
    if (url.pathname === "/api/stats") {
      return stub.fetch("https://do/stats?range=" + (url.searchParams.get("range") || "24h"));
    }
    return json({ error: "not found" }, 404);
  },
};

export class SpeedDB {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/store") {
      const rec = JSON.parse(await request.text());
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      rec.id = id;
      const tkey = "t:" + String(rec.ts).padStart(14, "0") + ":" + id;
      await this.storage.put("r:" + id, rec);
      await this.storage.put(tkey, {
        ts: rec.ts, city: rec.city, country: rec.country,
        lat: rec.lat, lon: rec.lon, down: rec.down, up: rec.up, ping: rec.ping,
      });
      if (Math.random() < 0.02) await this.prune(); // occasional cleanup of >31d stat keys
      return json({ id });
    }

    if (url.pathname === "/get") {
      const rec = await this.storage.get("r:" + (url.searchParams.get("id") || ""));
      return rec ? json(rec) : json({ error: "not found" }, 404);
    }

    if (url.pathname === "/stats") {
      const ms = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6 }[url.searchParams.get("range")] || 864e5;
      const start = "t:" + String(Date.now() - ms).padStart(14, "0");
      const list = await this.storage.list({ prefix: "t:", start, limit: 5000 });
      const byCity = new Map();
      for (const rec of list.values()) {
        if (rec.lat == null || rec.lon == null) continue;
        const key = (rec.city || rec.lat + "," + rec.lon) + "|" + (rec.country || "");
        let a = byCity.get(key);
        if (!a) { a = { city: rec.city, country: rec.country, lat: rec.lat, lon: rec.lon,
          down: 0, up: 0, ping: 0, upN: 0, n: 0 }; byCity.set(key, a); }
        a.n++; a.down += rec.down || 0; a.ping += rec.ping || 0;
        if (rec.up != null) { a.up += rec.up; a.upN++; }
      }
      const out = [...byCity.values()].map((a) => ({
        city: a.city, country: a.country, lat: a.lat, lon: a.lon, n: a.n,
        down: +(a.down / a.n).toFixed(1),
        up: a.upN ? +(a.up / a.upN).toFixed(1) : null,
        ping: Math.round(a.ping / a.n),
      }));
      return json(out);
    }

    return json({ error: "not found" }, 404);
  }

  async prune() {
    const cutoff = "t:" + String(Date.now() - 2592e6 - 864e5).padStart(14, "0");
    const old = await this.storage.list({ prefix: "t:", end: cutoff, limit: 500 });
    if (old.size) await this.storage.delete([...old.keys()]);
  }
}
