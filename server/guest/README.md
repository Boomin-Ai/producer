# Guest pages (self-hosted)

The three browser pages a guest of a self-hosted host touches, bundled so the
Producer server serves them from its own origin. A guest never contacts any
server but the host's.

| Route the Worker serves | Page | Who opens it |
| --- | --- | --- |
| `/connect/guest/:code` | `src/GuestJoinPage.tsx` | A person with an invite link |
| `/connect/guest/room/:code` | `src/GuestRoomPage.tsx` | A stranger with the room link (waits for admit) |
| `/connect/guest/render/:id?k=…&mic=…&program=…` | `src/GuestRenderPage.tsx` | Producer, as a browser source (headless, transparent) |

All three call the API at `window.location.origin + "/v1/connect"` (see
`src/apiConfig.ts`) and open signaling at
`wss://<origin>/v1/connect/guest-signal?ticket=…` /
`/v1/connect/guest-room-signal?…` — the path comes from the session response,
the page only fixes the scheme and origin.

## How it is served

`vite build` writes to `../public/guest/` (`index.html` + `assets/guest.js`)
with `base: "/guest/"`. **The output is committed.** A self-hoster runs
`wrangler deploy` and never needs Node for these pages.

The Worker is expected to:

1. Serve `server/public` as static assets (so `/guest/assets/guest.js` resolves).
2. Return `public/guest/index.html` for the three routes above. The bundle
   routes on `window.location.pathname` (`src/router.ts`), so any of the
   three paths served with the same HTML works.

## Rebuilding

There is deliberately **no `node_modules` here**. `react`, `react-dom`,
`vite` and `@vitejs/plugin-react` resolve from the repository root's
`node_modules` (Node walks up parent directories). Install at the root, then:

```sh
# from /server
npm run guest:typecheck   # tsc --noEmit -p guest
npm run guest:build       # vite build → server/public/guest
git add public/guest      # commit the output
```

Check the result never mentions the hosted service:

```sh
grep -rl "boomin.ai" public/guest && echo "STOP: hosted URL leaked" || echo ok
```

## Keeping in sync with the hosted pages

These files are copies of the hosted app's `src/pages/connect/Guest*.tsx` and
`src/lib/guestMesh.ts` with three changes, and only three:

- `react-router` replaced by `src/router.ts` (a pathname switch) and the route
  param passed in as a prop;
- `CONNECT_API_BASE_URL` derived from the page origin instead of a configured
  API host;
- hosted-service branding, analytics and fonts removed ("Powered by Producer").

When the hosted pages change (perfect negotiation, stage enforcement in
`guestMesh.ts`, the `?cam=producer` / `?name=` / `&mic=` / `&program=`
parameters), port the diff here and rebuild.
