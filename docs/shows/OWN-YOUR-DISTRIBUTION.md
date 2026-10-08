# Own Your Distribution — Founder POV

A vertical 1080×1920 short for Kleveland Bishop. Position: a builder explaining a design decision, then showing the system he built to address it. End with Atlantium iOS as the next chapter.

## Core thesis

**Your audience should survive a platform change.**

Use platforms for discovery and reach. Build direct, consent-based audience access on a domain you control, and build a business with your own products and payment relationships. People are not property; “own your audience” means owning the infrastructure and having permission to contact people directly.

Avoid the literal claim “you can't leave Twitch/Kick.” The sharper point is that switching platforms does not automatically move every follower, platform subscription or ongoing customer relationship.

## One segment, six visual beats

The set is `Own Your Distribution — Founder POV`. There is exactly one manual segment, `Own your distribution`. The six buttons switch graphics within that segment, with one stable live host binding and the same large camera rectangle throughout. All layouts are native 9:16. Keep the portrait room output selected.

| Approximate time | Button | Your delivery / visual purpose |
| --- | --- | --- |
| 0–7s | The hook | “If the platform disappeared tomorrow, what part of your business would you still have?” Lead with your face and a question. |
| 7–22s | Platform dependency | Twitch and Kick subscriptions in separate branded cards. Explain the dependency without implying creators cannot leave. |
| 22–35s | Direct audience | Platform logos feed into your domain, your opt-in audience and your customer relationships. Distinguish discovery from direct access. |
| 35–53s | Many destinations | Producer is the hub; Twitch, Kick and YouTube are destinations. One encoder pair supports simultaneous live outputs. Other destination logos illustrate compatible live ingest routes, subject to account access. |
| 53–67s | Your business | Audience → website → products → your payment account. Stripe/PayPal are illustrative choices. Talk about where you want to take direct commerce with Atlantium. |
| 67–80s | Open source | Open-source Producer proof, then Atlantium iOS as the next chapter. Close with a concrete founder invitation. |

Switch these buttons while recording; do not create extra show segments. Use a deliberate pause at each visual change. Captions have their own rail beneath the camera, above the platform UI safe area.

## Suggested spoken take

> If your platform disappeared tomorrow, what part of your business would you still have?
>
> That's the question I think more creators should ask.
>
> On Twitch, your subscriptions live on Twitch. On Kick, they live on Kick. You can change platforms. But every subscriber doesn't automatically move with you.
>
> I want platforms to be distribution channels, while my website, direct audience relationships and products are the foundation of my business.
>
> That's why I open-sourced Producer. It's a studio that lets you send one live show to multiple destinations at once. Under the hood, it shares the encoding work instead of building a separate studio for every platform.
>
> The point is choice: reach people where they already are, without making one platform the center of everything you build.
>
> And I'm thinking beyond the stream—your own products, your own checkout, your own payment relationship. That's part of the future I'm building toward with Atlantium iOS.
>
> Producer is open source. You can inspect it, run it and build on it.
>
> Don't just grow a channel. Build a business that can move with you.

This is roughly an 80-second take depending on pauses. For a tighter cut, remove the encoder explanation and shorten the first platform paragraph. Keep the first sentence and the final sentence.

## Production direction

- Deliver this as a founder explaining a decision, not as a platform takedown. Calm, specific, slightly challenging.
- Make your first line a direct question to the viewer; skip the name/introduction.
- Record a short Producer screen capture showing simultaneous destinations as proof. Add it in an edit after the “Many destinations” graphic, or use the existing reaction set for that separate insert.
- Keep the same camera crop across graphic changes; the diagrams carry the movement.
- Blue-white perimeter flare, dark navy field and large type provide continuity with AI Signal.
- Closing text currently says “Follow the build · Atlantium iOS.” No App Store URL or QR code is assumed.

## Assets and sources

34 SVG originals and PNG renderings are in `media/distribution-logos/`, including the SVGL Social category, Twitch, Kick, YouTube, GitHub, Stripe and PayPal. `manifest.json` records each asset's original SVGL URL and upstream download URL. The JSON embeds the eleven logos used by this set, plus the Atlantium mark; runtime rendering does not fetch external logos. Originals are retained for editing. SVGL's upstream license is retained as `SVGL-LICENSE.txt`.

- SVGL catalog and API: https://svgl.app/docs/api
- SVGL upstream assets: https://github.com/pheralb/svgl/tree/main/static/library
- Twitch simulcasting: https://help.twitch.tv/s/article/simulcasting-guidelines?language=en_US
- KICK Partner Program multistreaming: https://help.kick.com/en/articles/11091744-multistreaming-on-the-kick-partner-program
- Producer source: https://github.com/Boomin-Ai/producer

The current Producer engine has named Twitch/YouTube destinations and dashboard-ingest destinations for Kick/custom/Facebook/Instagram/Rumble/TikTok. Access to a particular platform's live ingest is required. Platform terms and partner arrangements still apply. The product/checkout visual is the founder's direction for Atlantium, not a claim that the current Producer UI has an integrated commerce checkout.

Interactive diagram segment (v1.3)

After the founder POV, enter “Own the network · Interactive diagram.” Use its four buttons to perform the argument: Platform owns it → Try to leave → Own the relationship → Stream everywhere. Let each move finish for about two seconds before the next cue. Audience nodes remain behind when the show moves, then gather under a direct relationship hub; Producer sends traveling light toward Twitch, Kick, and YouTube. These are conceptual audience relationships, not subscriber migration or a guarantee of destination access. Camera framing stays fixed throughout. The diagram uses native numeric keyframe tracks, grouped labels, and morph transitions without adding assets.
