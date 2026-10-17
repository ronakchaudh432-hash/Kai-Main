"use client";

// CAI mascot: minimal white rounded face on dark, two black oval eyes.
// Eye motion is the emotional channel; cursor tracking is spring-interpolated
// and clamped so eyes never leave the face. Honors prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";

export type MascotState =
  | "IDLE"
  | "TYPING"
  | "THINKING"
  | "SEARCHING"
  | "PROCESSING"
  | "RESPONDING"
  | "SUCCESS"
  | "ERROR"
  | "POKED"
  | "LISTENING"
  | "EXCITED"
  | "SLEEPY";

const STATE_META: Record<MascotState, { label: string; speed: number; amp: number }> = {
  IDLE: { label: "idle", speed: 1, amp: 3 },
  TYPING: { label: "typing", speed: 1.6, amp: 4 },
  THINKING: { label: "thinking", speed: 0.8, amp: 5 },
  SEARCHING: { label: "searching", speed: 1.2, amp: 7 },
  PROCESSING: { label: "processing", speed: 1.1, amp: 5 },
  RESPONDING: { label: "responding", speed: 1.8, amp: 4 },
  SUCCESS: { label: "success", speed: 1.4, amp: 3 },
  ERROR: { label: "error", speed: 0.7, amp: 2 },
  POKED: { label: "poked", speed: 2.2, amp: 6 },
  LISTENING: { label: "listening", speed: 1.4, amp: 4 },
  EXCITED: { label: "excited", speed: 2.5, amp: 8 },
  SLEEPY: { label: "sleepy", speed: 0.4, amp: 1 },
};

export function Mascot({
  state,
  assistantName,
  size = 56,
}: {
  state: MascotState;
  assistantName: string;
  size?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const eyeL = useRef<SVGEllipseElement>(null);
  const eyeR = useRef<SVGEllipseElement>(null);
  const faceRef = useRef<SVGGElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const cur = useRef({ x: 0, y: 0 });
  const [near, setNear] = useState(false);
  // Poke interaction: 0 = none, 1-3 = reaction variant. While poked, the
  // state machine reports POKED, then smoothly returns to the parent state.
  const [poke, setPoke] = useState(0);
  const pokeTimer = useRef(0);
  const idleTimer = useRef(0);
  const effective: MascotState = poke ? "POKED" : state;

  useEffect(() => () => window.clearTimeout(pokeTimer.current), []);

  useEffect(() => {
    idleTimer.current = Date.now();
  }, [effective]);

  const doPoke = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setPoke(1 + Math.floor(Math.random() * 6));
    window.clearTimeout(pokeTimer.current);
    pokeTimer.current = window.setTimeout(() => setPoke(0), 850);
  };

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const onMove = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 120) {
        setNear(true);
      } else {
        setNear(false);
      }
      // Bounded: max offset keeps eyes comfortably inside the face
      const max = 9;
      const mag = Math.min(max, (Math.min(dist, 320) / 320) * max);
      target.current = { x: (dx / dist) * mag, y: (dy / dist) * mag };
    };
    const onLeave = () => {
      target.current = { x: 0, y: 0 };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave, { passive: true });
    let raf = 0;
    let t = 0;
    const meta = STATE_META[effective];
    const tick = () => {
      t += 0.016 * meta.speed;
      // spring-like interpolation toward cursor target
      cur.current.x += (target.current.x - cur.current.x) * 0.12;
      cur.current.y += (target.current.y - cur.current.y) * 0.12;
      const driftX = Math.sin(t * 1.3) * 1.6;
      const driftY = Math.cos(t * 0.9) * 1.2;
      const floatY = Math.sin(t * 2) * meta.amp * 0.5;
      const l = eyeL.current;
      const rEl = eyeR.current;
      if (l && rEl) {
        const lx = cur.current.x + driftX;
        const ly = cur.current.y + driftY;
        const rx = cur.current.x - driftX * 0.4;
        const ry = cur.current.y - driftY * 0.4;
        l.setAttribute("cx", String(40 + lx));
        l.setAttribute("cy", String(46 + ly + floatY * 0.3));
        rEl.setAttribute("cx", String(64 + rx));
        rEl.setAttribute("cy", String(46 + ry + floatY * 0.3));
        // State expressions via eye height (POKED = happy squint)
        const narrow =
          effective === "SUCCESS" || effective === "POKED" || effective === "EXCITED"
            ? 0.55
            : effective === "ERROR"
              ? 1.25
              : effective === "THINKING" || effective === "LISTENING"
                ? 0.85
                : effective === "SLEEPY" || (effective === "IDLE" && Date.now() - idleTimer.current > 30000)
                  ? 0.4
                  : 1;
        l.setAttribute("ry", String(9 * narrow));
        rEl.setAttribute("ry", String(9 * narrow));
      }
      if (faceRef.current) {
        faceRef.current.setAttribute("transform", `translate(0 ${floatY.toFixed(2)})`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, [effective]);

  // Blink via CSS animation on a group (scaleY), disabled under reduced motion
  return (
    <div
      ref={wrapRef}
      className={`mascot-wrap${poke ? ` poked-${poke}` : ""}`}
      role="button"
      tabIndex={0}
      onClick={doPoke}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          doPoke();
        }
      }}
      onPointerLeave={() => { setNear(false); target.current = { x: 0, y: 0 }; }}
      aria-label={`${assistantName} assistant avatar — activate for a greeting`}
      data-state={STATE_META[effective].label}
      data-near={near ? 'true' : 'false'}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 104 104" width={size} height={size} aria-hidden="true">
        <g ref={faceRef}>
          <rect x="8" y="10" width="88" height="84" rx="42" fill="#f4f4f5" />
          <rect x="8" y="10" width="88" height="84" rx="42" fill="none" stroke="rgba(255,255,255,0.08)" />
          <g className="mascot-blink">
            <ellipse ref={eyeL} cx="40" cy="46" rx="7" ry="9" fill="#09090b" />
            <ellipse ref={eyeR} cx="64" cy="46" rx="7" ry="9" fill="#09090b" />
          </g>
          {effective === "ERROR" && (
            <path d="M42 70 Q52 64 62 70" stroke="#09090b" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          )}
          {(effective === "SUCCESS" || effective === "POKED") && (
            <path d="M42 68 Q52 74 62 68" stroke="#09090b" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          )}
          {effective === "EXCITED" && (
            <path d="M42 66 Q52 76 62 66" stroke="#09090b" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          )}
          {effective === "LISTENING" && (
            <ellipse cx="52" cy="70" rx="4" ry="3" fill="#09090b" />
          )}
          {effective === "SLEEPY" && (
            <path d="M46 68 L58 68" stroke="#09090b" strokeWidth="2" strokeLinecap="round" />
          )}
        </g>
      </svg>
    </div>
  );
}
