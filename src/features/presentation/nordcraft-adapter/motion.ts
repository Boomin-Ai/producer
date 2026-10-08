/** Modified bounded adaptation of Nordcraft core styling/style.css.ts
 * getNodeStyles keyframe emission. Upstream Apache-2.0; see NOTICE and LICENSE.
 * Producer restricts keys, values, duration and selectors before CSS emission.
 */
export function motionCss(name: string, property: 'opacity' | 'transform', from: string | number, to: string | number, durationMs: number, clockMs?: number) {
  if (!/^motion_[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid animation name.');
  if (clockMs !== undefined && (!Number.isFinite(clockMs) || clockMs < 0)) throw new Error('Invalid animation clock.');
  const clock = clockMs === undefined ? '' : `;animation-play-state:paused;animation-delay:-${clockMs % (durationMs * 2)}ms`;
  return `@keyframes ${name}{0%{${property}:${from}}100%{${property}:${to}}}\n.${name}{animation:${name} ${durationMs}ms ease-in-out infinite alternate${clock}}\n@media(prefers-reduced-motion:reduce){.${name}{animation:none}}`;
}
