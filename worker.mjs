/**
 * Crossbench — ONE Cloudflare Worker for everything (same pattern as tongits):
 *   - serves the site from ./public via the [assets] binding
 *   - runs the API on /api/* backed by a Durable Object
 * Deploy: npx wrangler deploy
 * Routes:
 *   POST /api/results        store a result   -> { id }
 *   GET  /api/results/:id    fetch a result   -> result JSON
 *   GET  /api/stats?range=24h|7d|30d          -> [{city,country,lat,lon,down,up,ping,n}]
 *   POST /api/servers        log CDN/site edges — accepts {servers:[…]} OR {list:[…]}
 *   GET  /api/servers        every edge ever recorded (they persist)
 *   POST /api/origins        count an anonymous ping origin (city-level, no IP)
 *   GET  /api/origins        all origins with counts
 *   POST /api/presence       record a map visit (city-level footprint, 1/city/hour)
 *   GET  /api/presence       visits in the last 24 h
 *   POST /api/log            anonymous session log (device id + pinged targets)
 *   GET  /api/log            latest sessions (feeds access.html)
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

// IPv4 or IPv6 — the frontend falls back to AAAA when a host has no A record
const IP4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IP6_RE = /^[0-9a-f:]{2,45}$/i; // colons + hex, incl. ::-compressed forms
const isIP = (v) => typeof v === "string" && (IP4_RE.test(v) || (v.includes(":") && IP6_RE.test(v)));
const HOST_RE = /^[a-z0-9.-]+$/i;

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

function sanitizeServer(s) {
  const out = {
    name: str(s.name, 40),
    host: str(s.host, 80),
    ip: str(s.ip, 45),
    lat: num(s.lat, -90, 90),
    lon: num(s.lon, -180, 180),
    org: str(s.org, 60),
    city: str(s.city, 60),
    country: str(s.country, 3),
    type: ["edge", "site", "hop", "custom"].includes(s.type) ? s.type : "edge",
  };
  if (!out.host && out.name && HOST_RE.test(out.name)) out.host = out.name; // ip-only custom targets
  if (!out.name) out.name = out.host;
  const ok = out.name && out.host && HOST_RE.test(out.host) && isIP(out.ip) &&
    out.lat != null && out.lon != null;
  if (!ok) return null;
  out.lat = +out.lat.toFixed(2); // ~city precision only
  out.lon = +out.lon.toFixed(2);
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // Everything that isn't /api/* is the website itself (from ./public)
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const stub = env.SPEED_DB.get(env.SPEED_DB.idFromName("global"));
    const cf = request.cf || {};
    const edgeGeo = () => {
      const g = {
        city: str(cf.city, 60), country: str(cf.country, 3),
        lat: num(cf.latitude, -90, 90), lon: num(cf.longitude, -180, 180),
      };
      if (g.lat != null) g.lat = +g.lat.toFixed(2);
      if (g.lon != null) g.lon = +g.lon.toFixed(2);
      return g;
    };

    // -------- who am I: same-origin geo so the map can ALWAYS draw your lines --------
    // (third-party locators get ad-blocked or rate-limited; the edge always knows)
    if (url.pathname === "/api/whoami") {
      const g = edgeGeo();
      return json({ ...g, org: str(cf.asOrganization, 80) || "" });
    }

    // -------- geoip: shared, visitor-seeded IP geolocation cache --------
    // Geo providers rate-limit/block Cloudflare's shared egress IPs, so the
    // worker NEVER calls them itself. GET is cache-only; on a miss the
    // visitor's browser does the lookup from its own residential IP (which is
    // what always worked) and POSTs the result back to seed the cache for
    // everyone. First visitor per IP pays one lookup; the rest hit the cache.
    if (url.pathname === "/api/geoip") {
      if (request.method === "POST") {
        let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const inRange = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
        if (!inRange(b.lat, -90, 90) || !inRange(b.lon, -180, 180)) return json({ error: "bad geo" }, 400);
        const rec = {
          ip: str(b.ip, 45),
          lat: num(b.lat, -90, 90), lon: num(b.lon, -180, 180),
          city: str(b.city, 60) || "", country: str(b.country, 3) || "",
          org: str(b.org, 60) || "",
        };
        if (!isIP(rec.ip) || rec.lat == null || rec.lon == null) return json({ error: "bad geo" }, 400);
        rec.lat = +rec.lat.toFixed(2); rec.lon = +rec.lon.toFixed(2);
        return stub.fetch("https://do/geo-post", { method: "POST", body: JSON.stringify(rec) });
      }
      const ip = str(url.searchParams.get("ip"), 45);
      if (!isIP(ip)) return json({ error: "bad ip" }, 400);
      return stub.fetch("https://do/geo-get?ip=" + encodeURIComponent(ip));
    }

    // -------- results (geo attached HERE — request.cf only exists at the edge) --------
    if (request.method === "POST" && url.pathname === "/api/results") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const rec = sanitize(body);
      if (rec.down == null) return json({ error: "no data" }, 400);
      Object.assign(rec, edgeGeo());
      return stub.fetch("https://do/store", { method: "POST", body: JSON.stringify(rec) });
    }
    if (url.pathname.startsWith("/api/results/")) {
      const id = url.pathname.split("/")[3] || "";
      return stub.fetch("https://do/get?id=" + encodeURIComponent(id));
    }

    if (url.pathname === "/api/stats") {
      return stub.fetch("https://do/stats?range=" + (url.searchParams.get("range") || "24h"));
    }

    // -------- servers: ONE handler, accepts BOTH payload shapes the pages send --------
    if (url.pathname === "/api/servers") {
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const raw = Array.isArray(body.servers) ? body.servers
                  : Array.isArray(body.list)    ? body.list
                  : [];
        const list = raw.slice(0, 20).map(sanitizeServer).filter(Boolean);
        if (!list.length) return json({ error: "no data" }, 400);
        return stub.fetch("https://do/servers", { method: "POST", body: JSON.stringify(list) });
      }
      return stub.fetch("https://do/servers");
    }

    // -------- anonymous ping origins --------
    if (url.pathname === "/api/origins") {
      if (request.method === "POST") {
        let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const o = { lat: num(b.lat, -90, 90), lon: num(b.lon, -180, 180),
          city: str(b.city, 40), country: str(b.country, 3) };
        if (o.lat == null || o.lon == null) return json({ error: "no geo" }, 400);
        return stub.fetch("https://do/origins", { method: "POST", body: JSON.stringify(o) });
      }
      return stub.fetch("https://do/origins");
    }

    // -------- map-visit presence (city-level footprint) --------
    if (url.pathname === "/api/presence") {
      if (request.method === "POST") {
        let body = {}; try { body = await request.json(); } catch {}
        const rec = { ts: Date.now(), vpn: !!body.vpn, ...edgeGeo() };
        if (rec.lat == null) return json({ ok: false });
        return stub.fetch("https://do/presence-post", { method: "POST", body: JSON.stringify(rec) });
      }
      return stub.fetch("https://do/presence-get");
    }

    // -------- session log (device id + pinged targets — feeds access.html) --------
    if (url.pathname === "/api/log") {
      if (request.method === "POST") {
        let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const rec = {
          ts: Date.now(),
          did: str(b.did, 24) || "anon",
          device: str(b.device, 80),
          page: str(b.page, 20),
          ...edgeGeo(),
          targets: Array.isArray(b.targets) ? b.targets.slice(0, 60).map((t) => ({
            host: str(t.host, 80), ip: str(t.ip, 45),
            ping: num(t.ping, 0, 10000),
            kind: ["server", "site", "custom"].includes(t.kind) ? t.kind : "server",
          })).filter((t) => t.host) : [],
        };
        return stub.fetch("https://do/log-post", { method: "POST", body: JSON.stringify(rec) });
      }
      return stub.fetch("https://do/log-get");
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
      if (Math.random() < 0.02) await this.prune(); // occasional cleanup
      return json({ id });
    }

    if (url.pathname === "/get") {
      const rec = await this.storage.get("r:" + (url.searchParams.get("id") || ""));
      return rec ? json(rec) : json({ error: "not found" }, 404);
    }

    if (url.pathname === "/origins") {
      if (request.method === "POST") {
        const o = JSON.parse(await request.text());
        const key = "o:" + o.lat.toFixed(1) + "|" + o.lon.toFixed(1);
        const cur = (await this.storage.get(key)) || { ...o, lat: +o.lat.toFixed(1), lon: +o.lon.toFixed(1), n: 0 };
        cur.n++; cur.ts = Date.now();
        if (o.city) cur.city = o.city;
        if (o.country) cur.country = o.country;
        await this.storage.put(key, cur);
        return json({ ok: true, n: cur.n });
      }
      const all = await this.storage.list({ prefix: "o:", limit: 1000 });
      return json([...all.values()]);
    }

    if (url.pathname === "/servers") {
      if (request.method === "POST") {
        const list = JSON.parse(await request.text());
        for (const s of list)
          await this.storage.put("srv:" + s.host + "|" + s.ip, { ...s, ts: Date.now() });
        return json({ ok: true, stored: list.length });
      }
      // merge current keys with any legacy "s:"-prefixed edges from older builds
      const [cur, legacy] = await Promise.all([
        this.storage.list({ prefix: "srv:", limit: 2000 }),
        this.storage.list({ prefix: "s:", limit: 1000 }),
      ]);
      const byKey = new Map();
      for (const v of legacy.values()) if (v && v.host && v.ip) byKey.set(v.host + "|" + v.ip, v);
      for (const v of cur.values()) if (v && v.host && v.ip) byKey.set(v.host + "|" + v.ip, v);
      return json([...byKey.values()]); // edges stay on the map once recorded
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

    if (url.pathname === "/log-post") {
      const rec = JSON.parse(await request.text());
      await this.storage.put("log:" + String(rec.ts).padStart(14, "0") + ":" + rec.did, rec);
      return json({ ok: true });
    }

    if (url.pathname === "/log-get") {
      const l = await this.storage.list({ prefix: "log:", limit: 500, reverse: true });
      return json([...l.values()]);
    }

    // "geo2:" — versioned on purpose: the previous server-side design
    // negative-cached provider failures under "geo:"; those entries are
    // poisoned and simply abandoned by the new key.
    if (url.pathname === "/geo-get") {
      const g = await this.storage.get("geo2:" + (url.searchParams.get("ip") || ""));
      return g ? json(g) : json({ error: "miss" }, 404);
    }

    if (url.pathname === "/geo-post") {
      const rec = JSON.parse(await request.text());
      const { ip, ...g } = rec;
      await this.storage.put("geo2:" + ip, { ...g, ts: Date.now() });
      return json({ ok: true });
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
    // session logs older than 7 days go too
    const logCut = "log:" + String(Date.now() - 6048e5).padStart(14, "0");
    const oldLogs = await this.storage.list({ prefix: "log:", end: logCut, limit: 500 });
    if (oldLogs.size) await this.storage.delete([...oldLogs.keys()]);
  }
}
