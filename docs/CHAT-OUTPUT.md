# Room chat on output

The host's chat panel contains a **Show on output** switch. It adds a saved
Chat browser source to the active scene; subsequent clicks change its visibility
in that scene. Studio can move, resize and layer it like other sources. The
source participates in the program output: streaming, recording and virtual
camera.

The local overlay bridge serves `/chat` and `/chat-state.json`. Native chat
readers feed it directly, so streaming chat does not depend on the room webview
remaining mounted. Vote overlay state and chat state are separate.

Messages combine connected Twitch, Kick and YouTube channels. The page has a
transparent background, username colors, text shadows and supported emotes. It
shows up to eight messages. They stay visible while chat is quiet; new messages
push older messages upward out of the overlay, with no fade or time limit.
Text is rendered as text nodes. Emote image URLs must use HTTPS. Native storage
is bounded to 24 messages and deduplicates platform message IDs.

The room restore starts the bridge and updates saved chat URLs if the local
port changed. Turning off the source retains its saved placement. Connecting
another channel clears that platform's recent messages and emote vocabulary.

Verification: production frontend build, two native bridge buffer tests,
`scripts/chat-overlay-browser.html` checks transparency, platform merging,
safe text, emotes, persistent messages and upward replacement. Tauri dev runs through `npm run dev:room`
with Vite on port 1420 and the installed engine's bundle topology.
