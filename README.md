# Crossbench — every speed test in one place

Cyberpunk multi-server internet speed test for **speed.playy.online**.
Same architecture as your tongits project: **ONE Cloudflare Worker** serves the
static site from `./public` and runs the `/api/*` backend on a Durable Object.
One repo, one deploy, one domain — no Pages project, no api. subdomain, no CORS.

```
worker.mjs            serves ./public + API (Durable Object database)
wrangler.toml         assets binding + DO + custom domain
package.json          npm run dev / npm run deploy
public/index.html     the speed test
public/result.html    shared-result pages   (speed.playy.online/result.html?id=…)
public/map.html       global telemetry map
.github/workflows/deploy-worker.yml   auto-deploys on every push
```

## Deploy

```bash
npm install
npx wrangler login
npm run deploy
```

Then attach **speed.playy.online** to this worker (Settings → Domains & Routes).
If speed.playy.online is still attached to an old Pages project or worker,
remove it there first. Delete the old crossbench-api worker if you made one —
the API now lives at speed.playy.online/api/*.

For auto-deploy on push: create a Cloudflare API token ("Edit Cloudflare
Workers" template) and save it as the GitHub repo secret **CLOUDFLARE_API_TOKEN**.

Local preview: `npm run dev` → http://localhost:8787 (site + API together).

## What's new in this build

- **Worker cleaned up**: the duplicated `/api/presence` / `/api/origins` /
  `/api/servers` route blocks are gone. `/api/servers` now accepts BOTH payload
  shapes the pages send (`{servers:[…]}` and `{list:[…]}`), keeps the `type`
  field (edge / site / hop / custom), accepts IPv6, and merges legacy `s:` keys.
- **`GET /api/whoami`**: same-origin visitor geo from the edge — the map uses it
  first, so connection lines draw even when third-party locators are ad-blocked.
- **`POST/GET /api/log`**: anonymous session log (device id + pinged targets),
  pruned after 7 days — ready for access.html.
- **IPv6 fallback**: if a host has no A record (or IPv4 lookup is blocked), the
  pages retry with AAAA; dns.google falls back to cloudflare-dns; ipwho.is falls
  back to ipapi.co.
- **CUSTOM target ping** on both pages: index.html gets a CUSTOM tab (centered
  tab pills) with a large URL/IP bar; map.html gets a CUSTOM tab in the ◇ SERVERS
  dropdown. Custom edges are pinned on everyone's map with `type:"custom"`.
- **MY LINKS is a switch**, and both dropdown lists (SERVERS / SITE LINKS) have a
  check-all switch.
- **Globe spin fixed**: touching or wheel-zooming pauses the spin; on resume the
  globe first re-centers (tilt → equator, zoom → 1, eased) and only then rotates
  on from its current position — no more jump.
- **Cluster instances are clickable**: picking one highlights it in red and swaps
  the red-bordered detail panel above.

## The map (Global connection telemetry)

- amCharts 5 chart, cyberpunk-styled: 3D rotating globe (drag to spin, auto-spin
  resumes after 4 s) or 2D map with infinite left–right scroll (same chart,
  equirectangular projection with rotate-panning).
- **Animated connection lines** (amCharts "map with animated lines" pattern):
  YOUR location is the pulsing origin; lines radiate to the real, live-measured
  test servers — Cloudflare, Netflix's Fast.com API, jsDelivr, Fastly, unpkg,
  cdnjs, GitHub, Wikimedia, Statically. Each server is pinged from your browser
  on page load; line color and packet-pulse speed reflect your actual ping.
  ◆ MY LINKS toggle hides/shows the whole overlay.
- Server diamonds are geolocated live (DNS-over-HTTPS → ipwho.is). These CDNs
  are anycast, so the plotted point is the edge nearest to the viewer — the
  detail panel says so.
- Tester glows = anonymous area aggregates (24h / 7d / 30d). Click any glow or
  diamond for a detail window. **All floating windows dock in the left rail.**
- amCharts free license requires keeping their small logo on the chart.

## Privacy

The Worker stores speeds, ping, jitter, ISP name, and city-level geo from
Cloudflare's edge (`request.cf`), rounded to 2 decimals. **Client IPs are never
stored**, so area panels can only ever show aggregates. Old stat keys (>31 days)
are pruned automatically.

## AdSense (Auto ads)

No ad units in the markup — Google places ads automatically:
1. Paste the AdSense loader `<script>` into the head of public/index.html and
   public/result.html (marked comment block), replacing ca-pub-XXXXXXXXXXXXXXXX.
2. AdSense dashboard → Ads → enable **Auto ads** for speed.playy.online.
3. Create `public/ads.txt`: `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0`

## SEO

Keyword copy, FAQ section, and JSON-LD schema are already in index.html.
After launch: add an og:image screenshot and submit the site to Google Search
Console and Bing Webmaster Tools.
