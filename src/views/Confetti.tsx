// A one-shot confetti burst for the end of the walkthrough. Canvas, no
// dependency: the CDN is not reachable from a Tauri webview and a physics
// library for four seconds of paper is not a trade worth making.
//
// Blue, white and black. Black on a dark room would be invisible, so black
// pieces carry a thin light rim — the colour is the founder's call, being
// able to SEE it is the implementation's job.
import { useEffect, useRef } from "react";

const BLUE = "#2f6fed";
const WHITE = "#ffffff";
const BLACK = "#0a0c10";

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  color: string;
  rimmed: boolean;
}

export function Confetti({ count = 140, seconds = 3.4 }: { count?: number; seconds?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Someone who asked the OS for less motion does not want paper thrown at
    // them; the card still says they finished.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    // Two jets from the lower corners, angled inward — a burst from the middle
    // of the screen covers the card the user is trying to read.
    const pieces: Piece[] = Array.from({ length: count }, (_, i) => {
      const left = i % 2 === 0;
      const spread = (Math.random() - 0.5) * 1.1;
      const speed = 11 + Math.random() * 9;
      const angle = (left ? -Math.PI / 3 : (-Math.PI * 2) / 3) + spread;
      const pick = Math.random();
      const color = pick < 0.45 ? BLUE : pick < 0.8 ? WHITE : BLACK;
      return {
        x: left ? -10 : w + 10,
        y: h + 10,
        vx: Math.cos(angle) * speed * (left ? 1 : -1) * -1,
        vy: Math.sin(angle) * speed,
        w: 5 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.34,
        color,
        rimmed: color === BLACK,
      };
    });

    let raf = 0;
    const started = performance.now();
    const total = seconds * 1000;

    const frame = (now: number) => {
      const t = now - started;
      if (t > total) {
        ctx.clearRect(0, 0, w, h);
        return;
      }
      // Fade the whole burst out over its last second rather than letting
      // pieces pop out of existence.
      const fade = t > total - 1000 ? Math.max(0, (total - t) / 1000) : 1;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = fade;
      for (const p of pieces) {
        p.vy += 0.32; // gravity
        p.vx *= 0.995; // drag
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        if (p.y > h + 40) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        // Flat rectangles tumbling: scaling the height by the rotation reads
        // as paper turning over without any 3-D maths.
        const hh = p.h * Math.abs(Math.cos(p.rot * 1.6));
        ctx.fillRect(-p.w / 2, -hh / 2, p.w, hh);
        if (p.rimmed) {
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.lineWidth = 0.75;
          ctx.strokeRect(-p.w / 2, -hh / 2, p.w, hh);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [count, seconds]);

  return <canvas ref={ref} className="walk-confetti" aria-hidden="true" />;
}
