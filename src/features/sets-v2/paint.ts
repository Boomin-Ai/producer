/** Declarative graphics paint, never HTML, URLs or executable CSS. Geometry,
 * clipping, transforms and group opacity belong to the ordered native graph. */
export const PAINT_KEYS = [
  "background",
  "color",
  "border",
  "borderRadius",
  "boxShadow",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "textAlign",
  "lineHeight",
  "fontFamily",
  "fontStyle",
  "textTransform",
  "textShadow",
  "whiteSpace",
  "wordSpacing",
  "backgroundSize",
  "backgroundPosition",
  "filter",
  "mixBlendMode",
  "clipPath",
  "padding",
  "display",
  "alignItems",
  "justifyContent",
] as const;
export type Paint = Partial<
  Record<(typeof PAINT_KEYS)[number], string | number>
>;
export function validatePaint(value: Paint): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid graphics paint");
  for (const [key, property] of Object.entries(value)) {
    const text = String(property).toLowerCase();
    if (
      !(PAINT_KEYS as readonly string[]).includes(key) ||
      !["string", "number"].includes(typeof property) ||
      (typeof property === "number" && !Number.isFinite(property)) ||
      text.length > 512 ||
      /[;{}<>\\@&\u0000-\u001f]/.test(text) ||
      [
        "url(",
        "var(",
        "expression(",
        "javascript:",
        "data:",
        "import",
        "!important",
      ].some((part) => text.includes(part))
    )
      throw Error("Invalid graphics paint property");
  }
}
