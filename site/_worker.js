// producer.dev edge worker (producer.boomin.ai redirects here).
// /download/<platform> streams the newest installer through this domain,
// so users never leave the site. Public handles use Boomin's anonymous identity;
// unpublished Set addresses stay unavailable. Other paths use static assets.

const REPO = "Boomin-Ai/producer";

const PLATFORMS = {
  "macos": [/aarch64.*\.dmg$/i],
  "macos-intel": [/x(86_)?64.*\.dmg$/i],
  "windows": [/-setup\.exe$/i, /\.exe$/i, /\.msi$/i],
  "linux": [/\.AppImage$/i, /\.deb$/i],
};

// This site consumes Boomin's existing anonymous, active-brand projection.
// It is not a second identity registry or a configurable upstream proxy.
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

function publicPath(pathname) {
  const parts = pathname.slice(1).split("/");
  if (parts.at(-1) === "") parts.pop();
  const root = parts[0]?.toLowerCase();
  // Static filenames and the existing system namespace retain ASSETS routing.
  if (!root || root.startsWith(".") || RESERVED_PUBLIC_ROOTS.has(root) || (parts.length === 1 && root.includes("."))) return null;
  if (parts.some(part => part === "")) return { kind: "invalid" };
  if (parts.length !== 1 && parts[1]?.toLowerCase() !== "set") return null;
  const valid = value => typeof value === "string" && value.length <= 80 && PUBLIC_SEGMENT.test(value.toLowerCase());
  if (!valid(parts[0])) return { kind: "invalid" };
  const handle = root;
  if (parts.length === 1) return { kind: "profile", handle, canonical: `/${handle}` };
  if (!valid(parts[2]) || parts.length > 4 || (parts.length === 4 && parts[3].toLowerCase() !== "download")) return { kind: "invalid" };
  const slug = parts[2].toLowerCase(), download = parts.length === 4;
  return { kind: download ? "set-download" : "set", handle, slug,
    canonical: `/${handle}/set/${slug}${download ? "/download" : ""}` };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function publicHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    // Identity deletion/withdrawal must not leave a public edge/browser copy.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}
function publicHtml(req, status, title, content, canonical) {
  const headers = publicHeaders();
  if (status !== 200) headers["X-Robots-Tag"] = "noindex, noarchive";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Producer</title>${canonical ? `<link rel="canonical" href="https://producer.dev${escapeHtml(canonical)}">` : ""}<style>
*{box-sizing:border-box}body{margin:0;background:#080d14;color:#eef4f7;font:16px/1.65 system-ui,-apple-system,sans-serif}a{color:inherit}header,main,footer{width:min(760px,100%);margin:auto;padding:24px}header{border-bottom:1px solid #26313f}header a{font-size:19px;font-weight:750;text-decoration:none;letter-spacing:-.5px}main{padding-top:64px;padding-bottom:64px}h1{font-size:clamp(32px,7vw,58px);line-height:1.1;letter-spacing:-1.5px;overflow-wrap:anywhere;margin:12px 0 16px}h2{font-size:22px;margin:0 0 8px}p{color:#aebdca;overflow-wrap:anywhere}.handle{color:#63d9b2;margin:0}.headline{font-size:21px;color:#e1eaf0}.bio{white-space:pre-wrap}.button{display:inline-block;border:1px solid #526270;border-radius:10px;padding:10px 16px;text-decoration:none;font-weight:600;margin:12px 0}.sets{margin-top:42px;padding-top:30px;border-top:1px solid #26313f}.sets p{margin-top:0}footer{border-top:1px solid #26313f;color:#8193a2;font-size:13px}
</style></head><body><header><a href="/">Producer</a></header><main>${content}</main><footer>Stop posting. Start producing.</footer></body></html>`;
  return new Response(req.method === "HEAD" ? null : html, { status, headers });
}
function publicNotFound(req) {
  return publicHtml(req, 404, "Page unavailable", "<h1>Page unavailable</h1><p>This address does not have a public profile or Set available.</p><a class=\"button\" href=\"/\">Explore Producer</a>");
}

async function publicIdentity(handle) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
  let reader, response;
  try {
    response = await fetch(`${PUBLIC_IDENTITY_ORIGIN}/v1/connect/b/${encodeURIComponent(handle)}`, {
      method: "GET",
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (response.status === 404) return { status: 404 };
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) return { status: 503 };
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > PUBLIC_IDENTITY_BYTES)) return { status: 503 };
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PUBLIC_IDENTITY_BYTES) return { status: 503 };
      text += decoder.decode(value, { stream: true });
    }
    const payload = JSON.parse(text + decoder.decode()), brand = payload?.brand;
    if (!brand || typeof brand.slug !== "string" || brand.slug.toLowerCase() !== handle ||
      typeof brand.name !== "string" || !brand.name.trim() || brand.name.length > 240) return { status: 503 };
    // Never spread/serialize the upstream payload. Even future public API
    // additions, avatars and authored URLs cannot create scripts or beacons.
    return { status: 200, brand: {
      name: brand.name,
      headline: typeof brand.headline === "string" ? brand.headline.slice(0, 280) : "",
      bio: typeof brand.bio === "string" ? brand.bio.slice(0, 4000) : "",
    } };
  } catch {
    return { status: 503 };
  } finally {
    clearTimeout(timeout);
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

async function publicPage(req, route, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) return new Response(null, { status: 405, headers: { ...publicHeaders(), Allow: "GET, HEAD" } });
  if (route.kind === "invalid") return publicNotFound(req);
  if (pathname !== route.canonical) return new Response(null, { status: 308, headers: { ...publicHeaders(), Location: `https://producer.dev${route.canonical}` } });
  // No package publication authority/store exists yet. An address or local
  // library entry is NOT permission to publish; all Set routes fail closed.
  if (route.kind === "set-download") return new Response(req.method === "HEAD" ? null : JSON.stringify({ error: { code: "public_set_unavailable", message: "No published Set is available at this address." } }), {
    status: 404, headers: { ...publicHeaders("application/json; charset=utf-8"), "X-Robots-Tag": "noindex, noarchive" },
  });
  if (route.kind === "set") return publicHtml(req, 404, "Set unavailable", "<h1>Set unavailable</h1><p>This address does not currently have a published Set to view or download.</p><a class=\"button\" href=\"/\">Explore Producer</a>");
  const identity = await publicIdentity(route.handle);
  if (identity.status === 404) return publicNotFound(req);
  if (identity.status !== 200) return publicHtml(req, 503, "Profile temporarily unavailable", "<h1>Temporarily unavailable</h1><p>We could not load this public profile. Please try again shortly.</p>");
  const { brand } = identity;
  return publicHtml(req, 200, `${brand.name} (@${route.handle})`, `<p class="handle">@${escapeHtml(route.handle)}</p><h1>${escapeHtml(brand.name)}</h1>${brand.headline ? `<p class="headline">${escapeHtml(brand.headline)}</p>` : ""}${brand.bio ? `<p class="bio">${escapeHtml(brand.bio)}</p>` : ""}<a class="button" href="https://boomin.ai/${encodeURIComponent(route.handle)}" rel="noopener noreferrer">View on Boomin</a><section class="sets"><h2>Sets</h2><p>Public Set downloads are not available yet.</p></section>`, route.canonical);
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
