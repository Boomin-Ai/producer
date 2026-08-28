// producer.boomin.ai edge worker.
// /download/<platform> streams the newest installer through this domain,
// so users never leave the site. Everything else falls through to static assets.

const REPO = "Boomin-Ai/producer";

const PLATFORMS = {
  "macos": [/aarch64.*\.dmg$/i],
  "macos-intel": [/x(86_)?64.*\.dmg$/i],
  "windows": [/-setup\.exe$/i, /\.exe$/i, /\.msi$/i],
  "linux": [/\.AppImage$/i, /\.deb$/i],
};

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

    const upstream = await fetch(asset.browser_download_url, {
      redirect: "follow",
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!upstream.ok || !upstream.body) return new Response("Download source failed.", { status: 502 });

    const headers = new Headers();
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", `attachment; filename="${asset.name}"`);
    const len = upstream.headers.get("content-length");
    if (len) headers.set("content-length", len);
    headers.set("cache-control", "public, max-age=3600");
    return new Response(upstream.body, { status: 200, headers });
  },
};
