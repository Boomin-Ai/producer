# Manager M0/M1 checkpoint — September 25, 2026

M0/M1 are implemented as a native Tauri development preview using deterministic sample data. No backend schema, API, provider or production deployment changed.

Run `npm run tauri:manager-preview` from the repository root. It starts the real Producer Tauri app with Manager selected in the existing navigation rail. The preview is development-only and uses sample data for any connected workspace; the existing Rooms, account and Settings surfaces remain available in the same native window. The regular `npm run tauri -- dev` command opens Rooms first, and Manager can be selected from its rail. The browser fixture shell has been removed.

Implemented:

- Overview on Manager entry, with today's releases, ideas, upcoming and published history. Ideas are static; no generation call.
- Persistent Manager collections siderail, collapse/expand, Stages, collection → unit → part tree. Collapse state uses desktop preferences when Tauri is available and local storage in browser preview.
- Stages tabs, collection view, unit detail, real part identities in fixtures, and standalone imported-post detail.
- Unit preview, caption, publication list, status and automation placement. Studio, revenue and performance metric presentation are absent from the new preview.
- Typed data contracts, bounded navigation state and an explicit fixture read adapter.
- Workspace-scoped remount in desktop development integration, using Producer's existing title bar, avatar and navigation rail.

Native Tauri capture:

- [Manager overview in Producer's actual window](previews/manager-native-overview.png)

Early browser layout captures (before native shell integration):

- [Overview at 1280×800](previews/manager-overview-1280.png)
- [Unit at 960×600](previews/manager-unit-960.png)
- [Part and expanded rail at 1280×800](previews/manager-part-1280.png)

Verification: `npm run build` passed TypeScript and Vite production bundling. `npm run tauri:manager-preview` built and launched the native app, and the Manager overview was visually checked in its actual Tauri window. The window-glass shim now builds without the optional live engine, so the dev rail gets the same native vibrancy setup as production. The earlier browser images above show only the Manager content layout; they are not the native-shell reference. No live CMS write, media upload, comment or DM test was run.

Next work is M2: hosted reads through the existing Tauri authenticated bridge, structured errors, endpoint-scoped query cache and permissions checks. Then M3 CMS actions and M4 automation attachment. The part and post details in M1 are visual/read-only; buttons that would mutate live data are not connected. Follow [the proposal](MANAGER-DESKTOP-PROPOSAL.md) and [Sol handoff](MANAGER-SOL-HANDOFF.md) for the source/API map and acceptance criteria.
