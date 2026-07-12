/**
 * Crossbench — ONE Cloudflare Worker for everything (same pattern as tongits):
 *   - serves the site from ./public via the [assets] binding
 *   - runs the API on /api/* backed by a Durable Object
 * Deploy: npx wrangler deploy
 * Routes:
 *   POST /api/results        store a result   -> { id }
 *   GET  /api/results/:id    fetch a result   -> result JSON
 *   GET  /api/stats?range=24h|7d|30d          -> [{city,country,lat,lon,down,up,ping,n}]
 *   POST /api/servers        log CDN edges a visitor's region resolved
 *   GET  /api/servers        all edges seen globally in the last 30 days
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
    vpn: !!body.vpn,
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
    if (url.pathname === "/api/presence") {
      if (request.method === "POST") {
        let body = {}; try { body = await request.json(); } catch {}
        const cf = request.cf || {};
        const rec = {
          ts: Date.now(), vpn: !!body.vpn,
          city: str(cf.city, 60), country: str(cf.country, 3),
          lat: num(cf.latitude, -90, 90), lon: num(cf.longitude, -180, 180),
        };
        if (rec.lat == null) return json({ ok: false });
        rec.lat = +rec.lat.toFixed(2); rec.lon = +rec.lon.toFixed(2);
        return stub.fetch("https://do/presence-post", { method: "POST", body: JSON.stringify(rec) });
      }
      return stub.fetch("https://do/presence-get");
    }
    if (url.pathname === "/api/servers") {
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const list = (Array.isArray(body.servers) ? body.servers : []).slice(0, 20)
          .map((s) => ({
            name: str(s.name, 30), host: str(s.host, 60), ip: str(s.ip, 45),
            lat: num(s.lat, -90, 90), lon: num(s.lon, -180, 180),
            org: str(s.org, 40), city: str(s.city, 40), country: str(s.country, 3),
          }))
          .filter((s) => s.host && /^[a-z0-9.-]+$/i.test(s.host) &&
            s.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(s.ip) &&
            s.lat != null && s.lon != null);
        return stub.fetch("https://do/servers", { method: "POST", body: JSON.stringify(list) });
      }
      return stub.fetch("https://do/servers");
    }
    if (url.pathname.startsWith("/api/results/")) {
      const id = url.pathname.split("/")[3] || "";
      return stub.fetch("https://do/get?id=" + encodeURIComponent(id));
    }
    if (url.pathname === "/api/stats") {
      return stub.fetch("https://do/stats?range=" + (url.searchParams.get("range") || "24h"));
    }
    if (url.pathname === "/api/presence") {
      if (request.method === "POST") {
        let body = {}; try { body = await request.json(); } catch {}
        const cf = request.cf || {};
        const rec = {
          ts: Date.now(), vpn: !!body.vpn,
          city: str(cf.city, 60), country: str(cf.country, 3),
          lat: num(cf.latitude, -90, 90), lon: num(cf.longitude, -180, 180),
        };
        if (rec.lat == null) return json({ ok: false });
        rec.lat = +rec.lat.toFixed(2); rec.lon = +rec.lon.toFixed(2);
        return stub.fetch("https://do/presence-post", { method: "POST", body: JSON.stringify(rec) });
      }
      return stub.fetch("https://do/presence-get");
    }
    if (url.pathname === "/api/servers") {
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const list = (Array.isArray(body.list) ? body.list : []).slice(0, 12).map((s) => ({
          name: str(s.name, 30), host: str(s.host, 60), ip: str(s.ip, 45),
          lat: num(s.lat, -90, 90), lon: num(s.lon, -180, 180),
          city: str(s.city, 60), country: str(s.country, 3), org: str(s.org, 60),
          type: ["edge", "site", "hop"].includes(s.type) ? s.type : "edge",
        })).filter((s) => s.name && s.ip && s.lat != null && s.lon != null);
        if (!list.length) return json({ error: "no data" }, 400);
        return stub.fetch("https://do/servers-post", { method: "POST", body: JSON.stringify(list) });
      }
      return stub.fetch("https://do/servers-get");
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
        isp: rec.isp, vpn: rec.vpn ? 1 : 0,
      });
      if (Math.random() < 0.02) await this.prune(); // occasional cleanup of >31d stat keys
      return json({ id });
    }

    if (url.pathname === "/get") {
      const rec = await this.storage.get("r:" + (url.searchParams.get("id") || ""));
      return rec ? json(rec) : json({ error: "not found" }, 404);
    }

    if (url.pathname === "/servers") {
      if (request.method === "POST") {
        const list = JSON.parse(await request.text());
        for (const s of list)
          await this.storage.put("srv:" + s.host + "|" + s.ip, { ...s, ts: Date.now() });
        return json({ ok: true, stored: list.length });
      }
      const all = await this.storage.list({ prefix: "srv:", limit: 500 });
      const cutoff = Date.now() - 2592e6; // 30 days
      return json([...all.values()].filter((s) => s.ts > cutoff));
    }

    if (url.pathname === "/presence-post") {
      const rec = JSON.parse(await request.text());
      // one point per city per hour — presence is a footprint, not tracking
      const slot = Math.floor(rec.ts / 36e5);
      await this.storage.put("p:" + slot + ":" + (rec.city || rec.lat + "," + rec.lon), rec);
      return json({ ok: true });
    }

    if (url.pathname === "/presence-get") {
      const minSlot = Math.floor((Date.now() - 864e5) / 36e5); // last 24 h
      const l = await this.storage.list({ prefix: "p:", limit: 1000 });
      return json([...l.values()].filter((r) => Math.floor(r.ts / 36e5) >= minSlot));
    }

    if (url.pathname === "/servers-post") {
      const list = JSON.parse(await request.text());
      for (const s of list) {
        s.lat = +s.lat.toFixed(2); s.lon = +s.lon.toFixed(2); // city precision
        await this.storage.put("s:" + s.name + "|" + s.ip, { ...s, ts: Date.now() });
      }
      return json({ ok: true });
    }

    if (url.pathname === "/servers-get") {
      const l = await this.storage.list({ prefix: "s:", limit: 2000 });
      return json([...l.values()]);
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
          down: 0, up: 0, ping: 0, upN: 0, n: 0, vpnN: 0, ispMap: {} }; byCity.set(key, a); }
        a.n++; a.down += rec.down || 0; a.ping += rec.ping || 0;
        if (rec.up != null) { a.up += rec.up; a.upN++; }
        if (rec.isp) { const k = String(rec.isp).slice(0, 60); a.ispMap[k] = (a.ispMap[k] || 0) + 1; }
        if (rec.vpn) a.vpnN++;
      }
      const out = [...byCity.values()].map((a) => ({
        city: a.city, country: a.country, lat: a.lat, lon: a.lon, n: a.n,
        down: +(a.down / a.n).toFixed(1),
        up: a.upN ? +(a.up / a.upN).toFixed(1) : null,
        ping: Math.round(a.ping / a.n),
        vpn: a.vpnN,
        isps: Object.entries(a.ispMap).sort((x, y) => y[1] - x[1]).slice(0, 6)
          .map(([name, n]) => ({ name, n })),
      }));
      return json(out);
    }

    return json({ error: "not found" }, 404);
  }

  async prune() {
    const cutoff = "t:" + String(Date.now() - 2592e6 - 864e5).padStart(14, "0");
    const old = await this.storage.list({ prefix: "t:", end: cutoff, limit: 500 });
    if (old.size) await this.storage.delete([...old.keys()]);
    // stale server edges (>60 days unseen)
    const srv = await this.storage.list({ prefix: "srv:", limit: 500 });
    const dead = [...srv.entries()].filter(([, v]) => v.ts < Date.now() - 5184e6).map(([k]) => k);
    if (dead.length) await this.storage.delete(dead);
  }
}
