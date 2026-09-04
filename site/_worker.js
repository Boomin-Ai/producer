// producer.dev edge worker (producer.boomin.ai redirects here).
// /download/<platform> streams the newest installer through this domain,
// so users never leave the site. Everything else falls through to static assets.

const REPO = "Boomin-Ai/producer";

const PLATFORMS = {
  "macos": [/aarch64.*\.dmg$/i],
  "macos-intel": [/x(86_)?64.*\.dmg$/i],
  "windows": [/-setup\.exe$/i, /\.exe$/i, /\.msi$/i],
  "linux": [/\.AppImage$/i, /\.deb$/i],
};

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
  // /releases/latest excludes prereleases, so list and take the newest non-draft.
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: {
      "user-agent": "producer-site",
      "accept": "application/vnd.github+json",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  const list = await res.json();
  return Array.isArray(list) ? list.find((r) => !r.draft && r.assets && r.assets.length) : null;
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
    if (!m) return env.ASSETS.fetch(req);

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
