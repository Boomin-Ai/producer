/**
 * What to call the machine the app is running on, in copy the user reads.
 * The keychain/binding language ("not on this Mac") is written from the user's
 * point of view, so on Windows it has to say Windows. No plugin needed: the
 * webview's platform string is enough to tell the two apart, and anything we
 * cannot identify gets the neutral word.
 */
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const IS_WINDOWS = /Windows/i.test(ua);
export const IS_MAC = /Mac OS X|Macintosh/i.test(ua) && !IS_WINDOWS;

/** "this Mac" / "this PC" / "this computer". */
export const THIS_DEVICE = IS_MAC ? "this Mac" : IS_WINDOWS ? "this PC" : "this computer";
