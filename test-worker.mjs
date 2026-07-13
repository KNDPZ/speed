import worker, { SpeedDB } from "./worker.mjs";

// ---- in-memory Durable Object storage stub ----
class MemStorage {
  constructor(){ this.m = new Map(); }
  async get(k){ return this.m.get(k); }
  async put(k,v){ this.m.set(k,v); }
  async delete(keys){ (Array.isArray(keys)?keys:[keys]).forEach(k=>this.m.delete(k)); }
  async list({prefix="",start,end,limit=1000,reverse=false}={}){
    let keys=[...this.m.keys()].filter(k=>k.startsWith(prefix)).sort();
    if(start)keys=keys.filter(k=>k>=start);
    if(end)keys=keys.filter(k=>k<end);
    if(reverse)keys.reverse();
    keys=keys.slice(0,limit);
    return new Map(keys.map(k=>[k,this.m.get(k)]));
  }
}
const doInstance = new SpeedDB({ storage: new MemStorage() });
const env = {
  SPEED_DB: { idFromName:()=> "id", get:()=>({ fetch:(u,i)=>doInstance.fetch(new Request(u,i)) }) },
  ASSETS: { fetch:()=> new Response("static asset") },
};
const cf = { city:"Cagayan de Oro", country:"PH", latitude:"8.4542", longitude:"124.6319", asOrganization:"Test ISP" };
const call = (path, init={}) => {
  const req = new Request("https://speed.playy.online"+path, init);
  Object.defineProperty(req, "cf", { value: cf });
  return worker.fetch(req, env);
};
const post = (path, body) => call(path, { method:"POST", body: JSON.stringify(body), headers:{"Content-Type":"application/json"} });

let pass=0, fail=0;
const check = (name, cond, extra="") => {
  if(cond){pass++;console.log("  ✓",name);} else {fail++;console.log("  ✗",name,extra);}
};

// 1. static passthrough
let r = await call("/index.html");
check("non-API serves assets", (await r.text())==="static asset");

// 2. whoami
r = await call("/api/whoami"); let j = await r.json();
check("whoami returns edge geo+org", j.city==="Cagayan de Oro" && j.lat===8.45 && j.org==="Test ISP");

// 3. results store + fetch + geo attach
r = await post("/api/results", { down: 87.5, up: 22.1, ping: 14, jit: 3, isp:"Test ISP", vpn:false,
  sources:[{n:"Cloudflare",ping:12,down:90}] });
j = await r.json();
check("result stored, id returned", typeof j.id==="string" && j.id.length===10);
r = await call("/api/results/"+j.id); const rec = await r.json();
check("result fetch has rounded city geo", rec.lat===8.45 && rec.lon===124.63 && rec.city==="Cagayan de Oro");
check("result keeps sources", rec.sources.length===1 && rec.sources[0].n==="Cloudflare");

// 4. servers — BOTH payload shapes, type kept, IPv6 accepted
r = await post("/api/servers", { servers:[{name:"Cloudflare",host:"speed.cloudflare.com",ip:"162.159.140.220",
  lat:37.7749,lon:-122.4194,org:"Cloudflare, Inc.",city:"San Francisco",country:"US",type:"edge"}] });
check("shape {servers:[…]} accepted", (await r.json()).ok===true);
r = await post("/api/servers", { list:[{name:"google.com",host:"google.com",ip:"142.250.72.14",
  lat:37.42,lon:-122.08,city:"Mountain View",country:"US",type:"site"}] });
check("shape {list:[…]} accepted", (await r.json()).ok===true);
r = await post("/api/servers", { list:[{name:"v6.example.com",host:"v6.example.com",ip:"2606:4700:4700::1111",
  lat:1.29,lon:103.85,city:"Singapore",country:"SG",type:"custom"}] });
check("IPv6 edge accepted", (await r.json()).ok===true);
r = await post("/api/servers", { list:[{name:"bad",host:"bad host!",ip:"999.1.1.1",lat:0,lon:0}] });
check("invalid host+ip rejected", r.status===400);
r = await call("/api/servers"); const edges = await r.json();
check("GET returns all 3 edges", edges.length===3, "got "+edges.length);
check("type persisted (site)", edges.some(e=>e.host==="google.com"&&e.type==="site"));
check("type persisted (custom, v6)", edges.some(e=>e.ip==="2606:4700:4700::1111"&&e.type==="custom"));

// legacy "s:" key migration path
await doInstance.storage.put("s:old.example|1.2.3.4", {name:"old.example",host:"old.example",ip:"1.2.3.4",lat:10,lon:10,type:"site"});
r = await call("/api/servers");
check("legacy s: keys merged into GET", (await r.json()).length===4);

// 5. origins
r = await post("/api/origins", { lat:8.4542, lon:124.6319, city:"Cagayan de Oro", country:"PH" });
check("origin counted", (await r.json()).n===1);
r = await post("/api/origins", { lat:8.4601, lon:124.6350, city:"Cagayan de Oro", country:"PH" });
check("nearby origin aggregates on 0.1° grid", (await r.json()).n===2);
r = await call("/api/origins");
check("origins list", (await r.json()).length===1);

// 6. presence
r = await post("/api/presence", { vpn:false });
check("presence recorded", (await r.json()).ok===true);
r = await call("/api/presence"); j = await r.json();
check("presence returned within 24h", j.length===1 && j[0].city==="Cagayan de Oro");

// 7. session log
r = await post("/api/log", { did:"abcd1234", device:"Windows · Chrome", page:"map",
  targets:[{host:"speed.cloudflare.com",ip:"162.159.140.220",ping:14,kind:"server"},
           {host:"google.com",ip:"142.250.72.14",ping:38,kind:"site"}] });
check("log accepted", (await r.json()).ok===true);
r = await call("/api/log"); j = await r.json();
check("log-get returns session with geo", j.length===1 && j[0].targets.length===2 && j[0].city==="Cagayan de Oro");

// 8. geoip — server-side lookup, cached once for everyone
let extCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s.startsWith("https://ipwho.is/")) {
    extCalls++;
    if (s.endsWith("/8.8.8.8"))
      return new Response(JSON.stringify({ success:true, latitude:37.4, longitude:-122.07,
        city:"Mountain View", country_code:"US", connection:{org:"Google LLC"} }));
    return new Response(JSON.stringify({ success:false }), { status:429 }); // rate-limited
  }
  if (s.startsWith("https://ipapi.co/")) {
    extCalls++;
    if (s.includes("1.1.1.1"))
      return new Response(JSON.stringify({ latitude:-27.47, longitude:153.03,
        city:"Brisbane", country_code:"AU", org:"Cloudflare" }));
    return new Response(JSON.stringify({ error:true }), { status:429 });
  }
  return realFetch(u, init);
};
r = await call("/api/geoip?ip=8.8.8.8"); j = await r.json();
check("geoip resolves via ipwho.is", j.city==="Mountain View" && j.org==="Google LLC");
const callsAfterFirst = extCalls;
r = await call("/api/geoip?ip=8.8.8.8"); j = await r.json();
check("second lookup served from DO cache", j.city==="Mountain View" && extCalls===callsAfterFirst);
r = await call("/api/geoip?ip=1.1.1.1"); j = await r.json();
check("falls back to ipapi.co when ipwho.is 429s", j.city==="Brisbane");
r = await call("/api/geoip?ip=203.0.113.9");
check("both providers down → 404 (negative-cached)", r.status===404);
const callsAfterFail = extCalls;
r = await call("/api/geoip?ip=203.0.113.9");
check("failed lookup not retried within 6h", r.status===404 && extCalls===callsAfterFail);
r = await call("/api/geoip?ip=not-an-ip");
check("invalid ip rejected", r.status===400);
globalThis.fetch = realFetch;

// 9. stats aggregation
r = await call("/api/stats?range=24h"); j = await r.json();
check("stats aggregates the test", j.length===1 && j[0].n===1 && j[0].down===87.5 && j[0].isps[0].name==="Test ISP");

// 10. 404
r = await call("/api/nope");
check("unknown API 404s", r.status===404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
