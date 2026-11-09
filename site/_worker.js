// producer.dev edge worker (producer.boomin.ai redirects here).
// /download/<platform> streams the newest installer through this domain,
// so users never leave the site. Public handles use Boomin's anonymous identity;
// published Sets are visibility-gated by the API. Other paths use static assets.

const REPO = "Boomin-Ai/producer";

const PLATFORMS = {
  "macos": [/aarch64.*\.dmg$/i],
  "macos-intel": [/x(86_)?64.*\.dmg$/i],
  "windows": [/-setup\.exe$/i, /\.exe$/i, /\.msi$/i],
  "linux": [/\.AppImage$/i, /\.deb$/i],
};

// Public pages have one fixed anonymous authority. Caller credentials, authored
// URLs and cache validators never cross this boundary. Visibility is checked by
// the API on EVERY request, including images and HEAD; withdrawn Sets stay gone.
const PUBLIC_IDENTITY_ORIGIN = "https://api.boomin.ai";
const PUBLIC_IDENTITY_BYTES = 1024 * 1024;
const PUBLIC_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_PUBLIC_ROOTS = new Set([
  "a", "c", "e", "l", "o", "r", "s", "t",
  "about", "account", "accounts", "admin", "api", "app", "assets", "audience", "auth",
  "blog", "brand", "brands", "cli", "connect", "console", "contact", "cookies", "creators",
  "dashboard", "debug", "demo-callback", "docs", "documentation", "download", "downloads",
  "events", "faq", "fb-project", "features", "fonts", "freestyler", "guest", "handoff",
  "health", "help", "igauth", "install", "integrations", "invite", "join", "live", "login",
  "logout", "network", "oauth", "partner", "portal", "postcard-preview", "press", "pricing",
  "privacy", "privacy-policy", "producer", "public", "publications", "register", "releases",
  "room-assets", "set", "sets", "settings", "shots", "sign-in", "sign-up", "signin", "signup",
  "static", "status", "support", "terms", "terms-and-conditions", "terms-of-service", "test",
  "tools", "update", "updates", "users", "v1", "well-known",
]);
const validSegment = value => typeof value === "string" && value.length <= 80 && PUBLIC_SEGMENT.test(value.toLowerCase());
function publicPath(pathname) {
  const parts = pathname.slice(1).split("/");
  if (parts.at(-1) === "") parts.pop();
  const root = parts[0]?.toLowerCase();
  if (!root || root.startsWith(".") || RESERVED_PUBLIC_ROOTS.has(root) || (parts.length === 1 && root.includes("."))) return null;
  if (parts.some(part => part === "")) return { kind: "invalid" };
  if (parts.length !== 1 && !["set", "sets", "og.png"].includes(parts[1]?.toLowerCase())) return null;
  if (!validSegment(parts[0])) return { kind: "invalid" };
  const handle = root, section = parts[1]?.toLowerCase();
  if (parts.length === 1) return { kind: "profile", handle, canonical: `/${handle}` };
  if (parts.length === 2 && section === "sets") return { kind: "gallery", handle, canonical: `/${handle}/sets` };
  if (parts.length === 2 && section === "og.png") return { kind: "profile-og", handle, canonical: `/${handle}/og.png` };
  if (!["set", "sets"].includes(section) || !validSegment(parts[2]) || parts.length > 4) return { kind: "invalid" };
  const slug = parts[2].toLowerCase(), suffix = parts[3]?.toLowerCase();
  if (suffix && !["download", "preview", "og.png"].includes(suffix)) return { kind: "invalid" };
  const kind = suffix === "og.png" ? "set-og" : suffix ? `set-${suffix}` : "set";
  return { kind, handle, slug, canonical: `/${handle}/set/${slug}${suffix ? `/${suffix}` : ""}` };
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function publicHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}
const producerMark = '<img class="brand-mark" src="/chair.png" width="32" height="32" alt="">';
function publicHtml(req, status, title, content, canonical, description = "Create something worth watching. Discover live Sets made with Producer.", image, noindex = false) {
  const headers = publicHeaders();
  if (status !== 200 || noindex) headers["X-Robots-Tag"] = "noindex, noarchive";
  const abs = canonical ? `https://producer.dev${canonical}` : null;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} · Producer</title><meta name="description" content="${escapeHtml(description)}">${abs ? `<link rel="canonical" href="${escapeHtml(abs)}"><meta property="og:url" content="${escapeHtml(abs)}">` : ""}<meta property="og:site_name" content="Producer"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta name="twitter:card" content="summary_large_image">${image ? `<meta property="og:image" content="https://producer.dev${escapeHtml(image)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="https://producer.dev${escapeHtml(image)}"><meta property="og:image:alt" content="${escapeHtml(title)} — Producer">` : ""}<style>
:root{color-scheme:dark;--bg:#080b10;--surface:#10161e;--line:#25303a;--text:#f1f5f5;--muted:#a4b1ba;--accent:#5ee2b4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}a:focus-visible{outline:3px solid var(--accent);outline-offset:5px}header,main,footer{width:min(1184px,100% - 64px);margin:auto}header{height:96px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:20px}.brand{display:flex;align-items:center;gap:12px;font-size:23px;font-weight:760;letter-spacing:-.9px}.brand-mark{display:block;width:32px;height:32px;object-fit:contain}.header-link{color:var(--muted);font-size:14px}.header-link:hover{color:var(--text)}main{padding:56px 0 88px}.eyebrow{text-transform:uppercase;font-size:11px;font-weight:750;letter-spacing:2px;color:var(--accent);margin:0 0 16px}h1,h2,h3,p{margin:0}h1{font-size:clamp(40px,6.5vw,78px);line-height:1.03;letter-spacing:-3px;font-weight:760;overflow-wrap:anywhere}h2{font-size:26px;line-height:1.25;letter-spacing:-.8px}h3{font-size:20px;letter-spacing:-.5px}h2,h3,.handle,.byline,.breadcrumb,.fact,.preview-label{overflow-wrap:anywhere}.hero>div:first-child{min-width:0}.muted,.bio{color:var(--muted)}.bio{font-size:18px;max-width:650px;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:22px}.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:36px;padding:24px 0 56px}.identity{display:flex;align-items:center;gap:18px;margin-bottom:28px}.avatar{width:64px;height:64px;background:linear-gradient(135deg,#253b35,#17212b);border:1px solid #3a554b;border-radius:50%;display:flex;justify-content:center;align-items:center;color:#b5f6d9;font-weight:700;font-size:24px}.handle{color:var(--muted);font-size:15px}.verified{display:inline-block;margin-top:5px;color:var(--accent);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase}.creator-count{flex-shrink:0;padding:24px 28px;border:1px solid var(--line);border-radius:16px;background:var(--surface);min-width:155px}.creator-count strong{display:block;font-size:42px;line-height:1.15;letter-spacing:-2px}.creator-count span{color:var(--muted);font-size:13px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 0;border-top:1px solid var(--line)}.section-head span{font-size:13px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.set-card{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--surface);transition:transform .18s,border-color .18s}.set-card:hover{transform:translateY(-3px);border-color:#5c706d}.art{aspect-ratio:16/9;position:relative;background:radial-gradient(ellipse at 80% 10%,#254037 0,transparent 65%),#10191e;overflow:hidden;border-bottom:1px solid var(--line)}.art img{display:block;width:100%;height:100%;object-fit:cover}.art-fallback{height:100%;display:flex;align-items:center;justify-content:center;padding:30px}.stage{width:78%;height:75%;background:linear-gradient(145deg,#243b34,#111922);box-shadow:0 20px 50px #0007;border:1px solid #5c8c784d;border-radius:8px;display:flex;flex-direction:column;padding:7%;justify-content:space-between}.stage-top{display:flex;gap:5px}.stage-top i{height:4px;width:16%;background:#b5dec9;border-radius:3px}.stage-title{font-size:clamp(15px,2vw,28px);font-weight:700;line-height:1.15;letter-spacing:-.8px;overflow-wrap:anywhere}.stage-bottom{height:17%;background:#b1e7cc18;border:1px solid #73c79b36;border-radius:3px}.card-body{padding:24px}.card-title{display:flex;justify-content:space-between;gap:15px;align-items:center}.arrow{color:var(--accent);font-size:24px}.card-body p{color:var(--muted);margin:10px 0 18px;font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{border:1px solid #34413e;border-radius:6px;padding:4px 9px;font-size:11px;color:#bbcbc6}.button{display:inline-flex;justify-content:center;align-items:center;gap:10px;border:1px solid #3a484f;border-radius:9px;padding:13px 20px;font-size:14px;font-weight:650}.button:hover{border-color:#87ada0}.button.primary{background:var(--accent);color:#092218;border-color:var(--accent)}.empty{padding:72px 24px;text-align:center;border:1px dashed var(--line);border-radius:14px}.empty p{color:var(--muted);margin-top:12px}.breadcrumb{color:var(--muted);font-size:13px;margin-bottom:32px;display:flex;gap:12px;flex-wrap:wrap}.breadcrumb a:hover{color:var(--text)}.set-heading{max-width:1000px;margin:20px 0 36px}.set-heading h1{font-size:clamp(36px,6vw,66px)}.set-heading .bio{max-width:790px}.set-content{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:28px;align-items:start}.preview-large{border:1px solid var(--line);border-radius:16px;overflow:hidden}.preview-large .art{border:0}.preview-label{padding:13px 18px;font-size:12px;color:var(--muted);background:var(--surface);border-top:1px solid var(--line)}.download-panel{border:1px solid #34443f;border-radius:16px;background:var(--surface);padding:26px;display:flex;flex-direction:column;gap:20px}.download-panel .button{width:100%}.facts{display:grid;gap:10px}.fact{display:flex;justify-content:space-between;gap:16px;font-size:13px}.fact span{color:var(--muted)}.instructions{font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:20px}.instructions strong{color:var(--text);font-weight:600}.byline{display:flex;align-items:center;gap:10px;font-size:14px;margin-top:24px}.byline .avatar{width:34px;height:34px;font-size:13px}.notice{font-size:12px;color:var(--muted)}.bottom-cta{margin-top:64px;padding:32px 0;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:24px;align-items:center}.bottom-cta p{color:var(--muted);font-size:14px;margin-top:8px}footer{border-top:1px solid var(--line);padding:28px 0 36px;display:flex;justify-content:space-between;gap:24px;font-size:12px;color:var(--muted)}.error{min-height:45vh;padding-top:48px}.error p{margin:24px 0;color:var(--muted)}@media(max-width:850px){.set-content{grid-template-columns:1fr}.download-panel{max-width:none}.hero{gap:24px}.creator-count{min-width:130px}.set-heading{margin-top:12px}}@media(max-width:600px){header,main,footer{width:calc(100% - 36px)}header{height:80px}.header-link{font-size:12px}main{padding:32px 0 56px}h1{letter-spacing:-1.8px}.hero{display:block;padding:12px 0 36px}.identity{gap:12px;margin-bottom:22px}.avatar{height:48px;width:48px;font-size:20px}.creator-count{display:inline-flex;align-items:baseline;gap:10px;margin-top:24px;padding:10px 16px;min-width:0}.creator-count strong{font-size:28px}.creator-count span{font-size:12px}.bio{font-size:16px}.grid{grid-template-columns:1fr;gap:18px}.card-body{padding:20px}.set-heading h1{letter-spacing:-1.6px}.bottom-cta{display:block;margin-top:42px}.bottom-cta .button{margin-top:20px}.breadcrumb{margin-bottom:24px}.section-head h2{font-size:23px}.section-head span{font-size:11px}footer{flex-direction:column;gap:8px}}
@media(prefers-reduced-motion:reduce){.set-card{transition:none}.set-card:hover{transform:none}}
</style></head><body><header><a class="brand" href="/" aria-label="Producer home">${producerMark}Producer</a><a class="header-link" href="/">Get Producer <span aria-hidden="true">↗</span></a></header><main>${content}</main><footer><span>Stop posting. Start producing.</span><a href="/">Made with Producer ↗</a></footer></body></html>`;
  return new Response(req.method === "HEAD" ? null : html, { status, headers });
}
function publicNotFound(req) {
  return publicHtml(req, 404, "Page unavailable", '<section class="error"><p class="eyebrow">Producer</p><h1>Page unavailable.</h1><p>This profile or Set is not publicly available.</p><a class="button" href="/">Explore Producer</a></section>');
}
function unavailable(req) {
  return publicHtml(req, 503, "Temporarily unavailable", '<section class="error"><h1>Back in a moment.</h1><p>We could not load this page. Please try again shortly.</p><a class="button" href="/">Explore Producer</a></section>');
}
const publicApiPath = route => `/v1/connect/producer/${route.handle}${route.slug ? `/sets/${route.slug}` : ""}`;
async function fetchPublic(path, { maxBytes = PUBLIC_IDENTITY_BYTES, accept = "application/json", head = false } = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  let reader, response;
  try {
    response = await fetch(`${PUBLIC_IDENTITY_ORIGIN}${path}`, {
      method: head ? "HEAD" : "GET", headers: { Accept: accept, "Cache-Control": "no-cache" }, credentials: "omit", redirect: "manual",
      signal: controller.signal, cf: { cacheTtl: 0, cacheEverything: false },
    });
    if ([404, 410].includes(response.status)) return { status: 404 };
    if (response.status !== 200 || (!head && !response.body)) return { status: 503 };
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!accept.split(",").includes(type)) return { status: 503 };
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return { status: 503 };
    // Only the fixed publication API can supply these headers. Normalize
    // digest values; never reflect arbitrary ETags or caller validators.
    const tag = /^(?:"([a-f0-9]{64})"|([a-f0-9]{64}))$/i.exec(response.headers.get("etag") ?? "");
    const sha = response.headers.get("x-content-sha256");
    const integrity = { etag: tag ? `"${(tag[1] ?? tag[2]).toLowerCase()}"` : null,
      sha256: /^[a-f0-9]{64}$/i.test(sha ?? "") ? sha.toLowerCase() : null };
    if (head) return { status: 200, type, length: length === null ? null : String(Number(length)), ...integrity };
    reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > maxBytes) return { status: 503 };
      chunks.push(value);
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return { status: 200, type, data, length: String(data.byteLength), ...integrity };
  } catch { return { status: 503 }; }
  finally {
    clearTimeout(timeout);
    if (reader) await reader.cancel().catch(() => {});
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}
function profileMetadata(value, handle) {
  if (!value || value.handle !== handle || typeof value.name !== "string" || !value.name.trim() || value.name.length > 240) return null;
  return { handle, name: value.name, bio: typeof value.bio === "string" ? value.bio.slice(0, 4000) : "" };
}
function setMetadata(value, handle, listed = false) {
  if (!value || value.handle !== handle || !validSegment(value.slug) || value.slug !== value.slug.toLowerCase() ||
    value.status !== "published" || !(listed ? value.visibility === "public" : ["public", "unlisted"].includes(value.visibility)) ||
    typeof value.title !== "string" || !value.title.trim() || value.title.length > 240 ||
    !Number.isSafeInteger(value.layout_count) || value.layout_count < 1 || value.layout_count > 1000) return null;
  return { slug: value.slug, title: value.title, description: typeof value.description === "string" ? value.description.slice(0, 4000) : "",
    layoutCount: value.layout_count, orientations: Array.isArray(value.orientations) ? [...new Set(value.orientations.filter(v => ["landscape", "portrait", "square"].includes(v)))] : [],
    version: Number.isSafeInteger(value.version) && value.version > 0 ? value.version : null,
    byteLength: Number.isSafeInteger(value.byte_length) && value.byte_length >= 0 ? value.byte_length : null,
    preview: typeof value.preview_url === "string" && value.preview_url.length > 0,
    unlisted: value.visibility === "unlisted" };
}
function fallbackArt(title) {
  return `<div class="art-fallback" aria-label="Set artwork"><div class="stage"><div class="stage-top"><i></i><i></i><i></i></div><div class="stage-title">${escapeHtml(title)}</div><div class="stage-bottom"></div></div></div>`;
}
function art(set, handle) {
  return `<div class="art">${set.preview ? `<img src="/${handle}/set/${set.slug}/preview" alt="${escapeHtml(set.title)} preview" loading="lazy" decoding="async">` : fallbackArt(set.title)}</div>`;
}
const chips = set => `<div class="chips"><span class="chip">${set.layoutCount} layout${set.layoutCount === 1 ? "" : "s"}</span>${set.orientations.map(o => `<span class="chip">${o === "portrait" ? "Vertical" : o === "square" ? "Square" : "Landscape"}</span>`).join("")}</div>`;
const initials = name => escapeHtml(Array.from(name.trim())[0]?.toUpperCase() || "P");
const bottomCta = '<section class="bottom-cta"><div><h2>Your next show starts here.</h2><p>A real studio. Original Sets. Your name on the output.</p></div><a class="button" href="/">Get Producer <span aria-hidden="true">↗</span></a></section>';
function profileContent(profile, sets) {
  const cards = sets.map(set => `<a class="set-card" href="/${profile.handle}/set/${set.slug}" aria-label="Explore ${escapeHtml(set.title)}">${art(set, profile.handle)}<div class="card-body"><div class="card-title"><h3>${escapeHtml(set.title)}</h3><span class="arrow" aria-hidden="true">↗</span></div>${set.description ? `<p>${escapeHtml(set.description)}</p>` : '<p>A ready-to-produce live Set.</p>'}${chips(set)}</div></a>`).join("");
  return `<section class="hero"><div><div class="identity"><span class="avatar" aria-hidden="true">${initials(profile.name)}</span><div><p class="handle">@${profile.handle}</p><span class="verified">Producer creator</span></div></div><h1>${escapeHtml(profile.name)}</h1>${profile.bio ? `<p class="bio">${escapeHtml(profile.bio)}</p>` : '<p class="bio">Original Sets. Made to go live.</p>'}</div><div class="creator-count"><strong>${sets.length}</strong><span>public Set${sets.length === 1 ? "" : "s"}</span></div></section><section aria-labelledby="sets-title"><div class="section-head"><h2 id="sets-title">Sets by ${escapeHtml(profile.name)}</h2><span>Made for your next show</span></div>${cards ? `<div class="grid">${cards}</div>` : '<div class="empty"><h3>Something good is coming.</h3><p>No public Sets to share just yet.</p></div>'}</section>${bottomCta}`;
}
function setContent(profile, set) {
  const size = set.byteLength === null ? null : set.byteLength < 1024 * 1024 ? `${Math.max(1, Math.round(set.byteLength / 1024))} KB` : `${(set.byteLength / (1024 * 1024)).toFixed(1)} MB`;
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/${profile.handle}">@${profile.handle}</a><span aria-hidden="true">/</span><a href="/${profile.handle}/sets">Sets</a><span aria-hidden="true">/</span><span>${escapeHtml(set.title)}</span></nav><section class="set-heading"><p class="eyebrow">A Producer Set${set.unlisted ? " · Unlisted" : ""}</p><h1>${escapeHtml(set.title)}</h1>${set.description ? `<p class="bio">${escapeHtml(set.description)}</p>` : ""}<a class="byline" href="/${profile.handle}"><span class="avatar" aria-hidden="true">${initials(profile.name)}</span><span>Made by <strong>${escapeHtml(profile.name)}</strong></span></a></section><div class="set-content"><section class="preview-large" aria-label="Set preview">${art(set, profile.handle)}<p class="preview-label">${set.preview ? "A look inside the Set. Your sources come alive in Producer." : "Set preview · Artwork will appear here when the creator adds a preview."}</p></section><aside class="download-panel"><div><p class="eyebrow">Ready when you are</p><h2>Make it your show.</h2></div>${chips(set)}<a class="button primary" href="/${profile.handle}/set/${set.slug}/download" download="${set.slug}.set.json">Download Set <span aria-hidden="true">↓</span></a><div class="facts">${set.version ? `<div class="fact"><span>Version</span><strong>${set.version}</strong></div>` : ""}${size ? `<div class="fact"><span>Download</span><strong>${size}</strong></div>` : ""}<div class="fact"><span>Format</span><strong>Producer Set</strong></div></div><p class="instructions"><strong>Import into Producer</strong><br>Download the Set, open your room’s Set editor, then choose Files → Import Set and select the downloaded file.</p><p class="notice">Need the studio? <a href="/"><u>Get Producer</u> ↗</a></p></aside></div><a class="button" style="margin-top:28px" href="/${profile.handle}/sets">← More from @${profile.handle}</a>${bottomCta}`;
}
async function publicBinary(req, route) {
  const download = route.kind === "set-download", preview = route.kind === "set-preview";
  const suffix = download ? "/download" : preview ? "/preview" : "/og.png";
  const fetched = await fetchPublic(publicApiPath(route) + suffix, {
    maxBytes: download ? 8388608 : preview ? 524288 : 4 * 1024 * 1024,
    accept: download ? "application/json" : preview ? "image/png,image/jpeg" : "image/png", head: req.method === "HEAD",
  });
  if (fetched.status === 404) return publicNotFound(req);
  if (fetched.status !== 200) return unavailable(req);
  const headers = publicHeaders(fetched.type);
  headers["X-Robots-Tag"] = "noindex, noarchive";
  if (fetched.length !== null) headers["Content-Length"] = fetched.length;
  if (fetched.etag) headers["ETag"] = fetched.etag;
  if (fetched.sha256) headers["X-Content-SHA256"] = fetched.sha256;
  if (download) headers["Content-Disposition"] = `attachment; filename="${route.slug}.set.json"`;
  return new Response(req.method === "HEAD" ? null : fetched.data, { headers });
}
async function publicPage(req, route, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) return new Response(null, { status: 405, headers: { ...publicHeaders(), Allow: "GET, HEAD" } });
  if (route.kind === "invalid") return publicNotFound(req);
  if (pathname !== route.canonical) return new Response(null, { status: 308, headers: { ...publicHeaders(), Location: `https://producer.dev${route.canonical}` } });
  if (["set-download", "set-preview", "set-og", "profile-og"].includes(route.kind)) return publicBinary(req, route);
  const fetched = await fetchPublic(publicApiPath(route));
  if (fetched.status === 404) return publicNotFound(req);
  if (fetched.status !== 200) return unavailable(req);
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fetched.data)); } catch { return unavailable(req); }
  const profile = profileMetadata(route.kind === "set" ? payload?.profile : payload, route.handle);
  if (!profile) return unavailable(req);
  if (route.kind === "set") {
    const set = setMetadata(payload?.publication, route.handle);
    if (!set || set.slug !== route.slug) return publicNotFound(req);
    return publicHtml(req, 200, `${set.title} by ${profile.name}`, setContent(profile, set), route.canonical,
      set.description || `${set.title}, a live Set made by ${profile.name} with Producer.`, `/${route.handle}/set/${route.slug}/og.png`, set.unlisted);
  }
  if (!Array.isArray(payload.sets) || payload.sets.length > 200) return unavailable(req);
  const sets = payload.sets.map(value => setMetadata(value, route.handle, true)).filter(Boolean);
  return publicHtml(req, 200, `${profile.name} (@${route.handle})${route.kind === "gallery" ? " — Sets" : ""}`, profileContent(profile, sets), route.canonical,
    profile.bio || `Discover original Producer Sets by ${profile.name}.`, `/${route.handle}/og.png`);
}

// Clean save-as names — users see these, not the build artifact names.
function cleanName(platform, assetName) {
  const ext = assetName.slice(assetName.lastIndexOf("."));
  return {
    "macos": "Producer.dmg",
    "macos-intel": "Producer-Intel.dmg",
    "windows": "Producer-Setup" + ext,
    "linux": "Producer" + ext,
  }[platform] || assetName;
}

async function latestRelease() {
  // Public downloads follow the stable channel; private/performance candidates
  // must not replace its installers merely because they were published later.
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      "user-agent": "producer-site",
      "accept": "application/vnd.github+json",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  const release = await res.json();
  return release && !release.draft && !release.prerelease && Array.isArray(release.assets) && release.assets.length ? release : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Canonical host is producer.dev; the old boomin.ai subdomain (and www)
    // permanently redirect so every existing link and installer page keeps
    // working while the brand moves to its own domain.
    if (url.hostname !== "producer.dev" && !url.hostname.endsWith(".pages.dev")) {
      url.hostname = "producer.dev";
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    // Public room pages reuse Boomin's dedicated room bundle. Only HTML and
    // assets pass through this site; API/WebSocket/media paths stay unchanged.
    const branded = /^\/[^/]+\/(?:audience\/[^/]+|guest\/[^/]+\/(?:gr_|gi_)[A-Za-z0-9_-]+)\/?$/.test(url.pathname);
    const roomAsset = url.pathname.startsWith("/room-assets/");
    const legacy = /^\/audience\/[^/]+\/?$/.test(url.pathname) || /^\/connect\/guest\/(?:room\/)?(?:gr_|gi_)[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    if (branded || roomAsset || legacy) {
      if (!["GET", "HEAD"].includes(req.method)) return new Response("Method not allowed", { status: 405 });
      const upstreamUrl = new URL(url.pathname + url.search, "https://boomin.ai");
      if (legacy) { upstreamUrl.pathname = "/room-assets/room"; upstreamUrl.search = ""; }
      const upstream = await fetch(upstreamUrl, {
        headers: { accept: roomAsset ? "*/*" : "text/html" },
        redirect: "manual",
      });
      if (!upstream.ok || (roomAsset && upstream.headers.get("content-type")?.includes("text/html")))
        return new Response("The room page is temporarily unavailable. Please try again.", { status: 503, headers: { "Cache-Control": "no-store" } });
      const headers = new Headers(upstream.headers);
      headers.delete("set-cookie");
      headers.set("Cache-Control", roomAsset ? "no-cache" : "no-store");
      headers.set("Referrer-Policy", "no-referrer");
      if (roomAsset) return new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
      // The upstream shell contains no credentials in its metadata. Keep the
      // public brand and canonical audience URL on the selected domain.
      headers.delete("content-length");
      headers.delete("content-encoding");
      let html = await upstream.text();
      html = html.replace(/<meta property="og:site_name" content="[^"]*">/, '<meta property="og:site_name" content="Producer">');
      if (!url.pathname.includes("/guest/")) {
        const escape = value => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escape(url.origin + url.pathname)}">`);
      }
      return new Response(req.method === "HEAD" ? null : html, { status: upstream.status, headers });
    }

    if (url.pathname === "/download/meta.json") {
      const rel = await latestRelease();
      if (!rel) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      const meta = { version: rel.tag_name, platforms: {} };
      for (const [key, patterns] of Object.entries(PLATFORMS)) {
        const asset = rel.assets.find((a) => patterns.some((re) => re.test(a.name)));
        if (asset) meta.platforms[key] = { name: asset.name, size: asset.size };
      }
      return new Response(JSON.stringify(meta), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
      });
    }

    const m = url.pathname.match(/^\/download\/(macos|macos-intel|windows|linux)\/?$/);
    if (!m) {
      const route = publicPath(url.pathname);
      return route ? publicPage(req, route, url.pathname) : env.ASSETS.fetch(req);
    }

    const rel = await latestRelease();
    if (!rel || !rel.assets) return new Response("Release temporarily unavailable.", { status: 503 });

    const patterns = PLATFORMS[m[1]];
    const asset = rel.assets.find((a) => patterns.some((re) => re.test(a.name)));
    if (!asset) return new Response("No build for this platform yet.", { status: 404 });

    // Cache-key on the asset id: rebuilt releases reuse the same URL, and
    // without this the edge keeps serving the previous binary for an hour.
    const upstream = await fetch(`${asset.browser_download_url}?ck=${asset.id}`, {
      redirect: "follow",
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!upstream.ok || !upstream.body) return new Response("Download source failed.", { status: 502 });

    const headers = new Headers();
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", `attachment; filename="${cleanName(m[1], asset.name)}"`);
    const len = upstream.headers.get("content-length");
    if (len) headers.set("content-length", len);
    // No caching of the response envelope — the filename header must always be current.
    // (The upstream GitHub fetch above is still edge-cached, so downloads stay fast.)
    headers.set("cache-control", "no-store");
    return new Response(upstream.body, { status: 200, headers });
  },
};
