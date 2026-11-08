# Threads dashboard

Boomin workspaces expose their connected Threads account in Producer’s Settings → Integrations and Manager’s posting channels. New Manager posts start as text. Threads supports text without media or one image/video through the desktop composer; Instagram keeps its media requirement. The existing CMS publishing queue and native outbox remain responsible for publishing.

Import **Threads · Live Dashboard**, open **Set Edit → Data connections**, choose your Threads account, choose a 7- or 30-day period, and select a published post. Apply the Set. The selected post drives both Post spotlight and Live replies; Channel overview shows account metrics. All three views have paired landscape and portrait compositions and one shared Host camera slot. The post picker loads additional pages on request.

The portable Set contains no account ID, post ID or credentials. Connection revision, post selection and date range stay in the room’s private module bindings. Recipients connect their own account. Self-hosted servers can import the design; a trusted social adapter is required to supply data.

Account views are profile views, not aggregate post views. Followers are the current total. Account metrics use provider windows; post metrics are lifetime counters. Missing metrics display — and genuine measured zero displays 0. Each section displays its observation time. Account/post refreshes use Boomin sync jobs, with account refresh after two minutes and post refresh after one minute. Replies come from Boomin’s signed webhook ingestion and the latest six stored replies are checked every three seconds while the Set is on output. A short excerpt is shown for long posts and replies; Manager retains the full text. Provider insight updates can lag the conversation.

The runtime uses data.social@1, social.selection@1 and social.dashboard@1. Social updates require trusted connector authority, a running module and current Set/module epochs. Older snapshots are rejected. Errors retain the last visible values. Identical observations do not write a new runtime revision or rebuild the Set. Changing accounts invalidates the saved connection revision and requires rebinding.

Authoring and validation use the bundled Producer MCP compiler. Browser previews use placeholder cameras; native rendering must be checked separately. Focused checks: npm run test:threads-social and npm run test:threads-browser (with a Vite server on port 1447).
