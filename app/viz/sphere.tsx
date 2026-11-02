"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VizData } from "@/web/viz-data";

/**
 * BINGO knowledge sphere: modules sit on a globe, every real record orbits its
 * module, knowledge-graph links connect records, and energy rays run from the
 * core to each module. Drag to rotate, hover for details, click to open.
 */
const TONE: Record<string, string> = { good: "#39ff9c", bad: "#ff3b5c", warn: "#ffb020", info: "#38d6ff" };
const RAYS = ["#38d6ff", "#2d7bff", "#7c5cff", "#ff3b5c", "#ffb020", "#39ff9c"];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type P3 = { x: number; y: number; z: number };
const fromLatLon = (lat: number, lon: number, r = 1): P3 => ({ x: r * Math.cos(lat) * Math.sin(lon), y: r * Math.sin(lat), z: r * Math.cos(lat) * Math.cos(lon) });

export function KnowledgeSphere({ data, height = 560 }: { data: VizData; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const view = useRef({ yaw: 0.6, pitch: -0.25 });
  const sig = useMemo(() => JSON.stringify(data), [data]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Module anchors on a Fibonacci sphere (stable positions).
    const n = data.modules.length;
    const anchors = new Map<string, P3>();
    data.modules.forEach((m, i) => {
      const y = 1 - (2 * (i + 0.5)) / n;
      const lat = Math.asin(y * 0.86);
      const lon = i * Math.PI * (3 - Math.sqrt(5));
      anchors.set(m.key, fromLatLon(lat, lon));
    });
    // Records cluster around their module, deterministically.
    const groupSize = new Map<string, number>();
    for (const nd of data.nodes) groupSize.set(nd.group, (groupSize.get(nd.group) ?? 0) + 1);
    const pts = data.nodes.map((nd) => {
      const a = anchors.get(nd.group) ?? { x: 0, y: 0, z: 1 };
      const lat0 = Math.asin(a.y);
      const lon0 = Math.atan2(a.x, a.z);
      const r1 = hash(nd.id);
      const r2 = hash(`${nd.id}#`);
      const scale = Math.min(2.2, 0.6 + Math.sqrt(groupSize.get(nd.group) ?? 1) / 4);
      const spread = (0.1 + 0.34 * Math.sqrt(r1)) * scale;
      const ang = r2 * Math.PI * 2;
      return { nd, p: fromLatLon(Math.max(-1.45, Math.min(1.45, lat0 + Math.sin(ang) * spread)), lon0 + (Math.cos(ang) * spread) / Math.max(0.35, Math.cos(lat0))) };
    });
    const byId = new Map(pts.map((x) => [x.nd.id, x]));
    // Background dust: shell of coloured particles, denser near the rim like a nebula.
    const rnd = rng(42);
    const dust = Array.from({ length: 1400 }, () => {
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const r = 0.92 + rnd() * 0.1;
      const s = Math.sqrt(1 - u * u);
      const c = rnd();
      return { p: { x: r * s * Math.cos(t), y: r * u, z: r * s * Math.sin(t) }, c: c < 0.55 ? "#2d7bff" : c < 0.75 ? "#38d6ff" : c < 0.86 ? "#39ff9c" : c < 0.94 ? "#ff3b5c" : "#ffb020", s: rnd() * 1.6 + 0.3 };
    });

    let yaw = view.current.yaw;
    let pitch = view.current.pitch;
    let drag: { x: number; y: number; yaw: number; pitch: number } | null = null;
    let W = 0;
    let H = 0;
    let projected: { x: number; y: number; z: number; nd: (typeof pts)[number]["nd"] }[] = [];
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = wrap.current!.clientWidth;
      H = height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current!);
    resize();

    const project = (p: P3, R: number) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const x1 = p.x * cy + p.z * sy;
      const z1 = -p.x * sy + p.z * cy;
      const y2 = p.y * cp - z1 * sp;
      const z2 = p.y * sp + z1 * cp;
      const f = 3.2 / (3.2 - z2);
      return { x: W / 2 + x1 * R * f, y: H / 2 - y2 * R * f, z: z2, f };
    };

    const draw = () => {
      const R = Math.min(W, H) * 0.44;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      // Halo
      const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15);
      g.addColorStop(0, "rgba(45,123,255,0.10)");
      g.addColorStop(0.75, "rgba(56,214,255,0.04)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // Wireframe globe
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(140,180,255,0.09)";
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        for (let lon = 0; lon <= 360; lon += 6) {
          const q = project(fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180), R);
          lon === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      }
      for (let lon = 0; lon < 180; lon += 30) {
        ctx.beginPath();
        for (let t = -90; t <= 270; t += 6) {
          const lat = t <= 90 ? t : 180 - t;
          const lo = t <= 90 ? lon : lon + 180;
          const q = project(fromLatLon((lat * Math.PI) / 180, (lo * Math.PI) / 180), R);
          t === -90 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(140,180,255,0.22)";
      ctx.lineWidth = 1;
      ctx.stroke();
      // Dust
      for (const d of dust) {
        const q = project(d.p, R);
        const a = 0.25 + 0.6 * ((q.z + 1) / 2);
        ctx.globalAlpha = a;
        ctx.fillStyle = d.c;
        ctx.fillRect(q.x, q.y, d.s * q.f, d.s * q.f);
      }
      ctx.globalAlpha = 1;
      // Energy rays from the core to each module (curved, glowing)
      const core = { x: cx, y: cy };
      data.modules.forEach((m, i) => {
        const q = project(anchors.get(m.key)!, R);
        const col = m.bad ? "#ff3b5c" : RAYS[i % RAYS.length]!;
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.25 + 0.45 * ((q.z + 1) / 2);
        ctx.lineWidth = 1.1;
        ctx.shadowColor = col;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(core.x, core.y);
        const mx = (core.x + q.x) / 2 + (q.y - core.y) * 0.25;
        const my = (core.y + q.y) / 2 - (q.x - core.x) * 0.25;
        ctx.quadraticCurveTo(mx, my, q.x, q.y);
        ctx.stroke();
      });
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      // Core
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 26);
      cg.addColorStop(0, "rgba(220,250,255,0.95)");
      cg.addColorStop(0.3, "rgba(56,214,255,0.55)");
      cg.addColorStop(1, "rgba(56,214,255,0)");
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, 26, 0, Math.PI * 2);
      ctx.fill();
      // Record nodes and links
      projected = [];
      const P = new Map<string, ReturnType<typeof project>>();
      for (const { nd, p } of pts) {
        const q = project(p, R);
        P.set(nd.id, q);
        projected.push({ x: q.x, y: q.y, z: q.z, nd });
      }
      ctx.lineWidth = 0.7;
      for (const { nd } of pts) {
        const q = P.get(nd.id)!;
        const a = project(anchors.get(nd.group)!, R);
        ctx.strokeStyle = `rgba(225,235,255,${0.06 + 0.22 * ((q.z + 1) / 2)})`;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(a.x, a.y);
        ctx.stroke();
      }
      for (const [a, b] of data.links) {
        const qa = P.get(a), qb = P.get(b);
        if (!qa || !qb) continue;
        ctx.strokeStyle = `rgba(56,214,255,${0.08 + 0.3 * ((qa.z + qb.z + 2) / 4)})`;
        ctx.beginPath();
        ctx.moveTo(qa.x, qa.y);
        ctx.lineTo(qb.x, qb.y);
        ctx.stroke();
      }
      projected.sort((a, b) => a.z - b.z);
      for (const q of projected) {
        const depth = (q.z + 1) / 2;
        const col = TONE[q.nd.tone]!;
        ctx.globalAlpha = 0.25 + 0.75 * depth;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3.6 + depth * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 1.6 + depth, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      // Module labels
      ctx.font = "600 12.5px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = "center";
      for (const m of data.modules) {
        const q = project(anchors.get(m.key)!, R);
        const depth = (q.z + 1) / 2;
        if (depth < 0.18) continue;
        ctx.globalAlpha = 0.25 + 0.75 * depth;
        ctx.fillStyle = "#f2f7ff";
        ctx.shadowColor = "rgba(56,214,255,0.9)";
        ctx.shadowBlur = 12;
        const label = m.label.split("").join(" ");
        ctx.fillText(label, q.x, q.y - 12);
        ctx.shadowBlur = 0;
        ctx.font = "500 10px 'JetBrains Mono', ui-monospace, monospace";
        ctx.fillStyle = m.bad ? "#ff7a8c" : "rgba(160,190,230,0.9)";
        ctx.fillText(`${m.count}${m.bad ? ` · ${m.bad} ⚠` : ""}`, q.x, q.y + 4);
        ctx.font = "600 12.5px 'JetBrains Mono', ui-monospace, monospace";
      }
      ctx.globalAlpha = 1;
    };
    const loop = () => {
      draw();
      if (!drag) yaw += 0.0016;
      view.current = { yaw, pitch };
      raf = requestAnimationFrame(loop);
    };
    if (reduce) draw();
    else loop();

    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hit = (x: number, y: number) => {
      let best: (typeof projected)[number] | null = null;
      let bd = 12 * 12;
      for (const q of projected) {
        if (q.z < -0.1) continue;
        const d = (q.x - x) ** 2 + (q.y - y) ** 2;
        if (d < bd) (bd = d), (best = q);
      }
      return best;
    };
    let moved = false;
    const down = (e: PointerEvent) => {
      moved = false;
      drag = { ...pos(e), yaw, pitch };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const p = pos(e);
      if (drag) {
        if (Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 3) moved = true;
        yaw = drag.yaw + (p.x - drag.x) * 0.006;
        pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + (p.y - drag.y) * 0.006));
        view.current = { yaw, pitch };
        if (reduce) draw();
        return;
      }
      const h = hit(p.x, p.y);
      canvas.style.cursor = h ? "pointer" : "grab";
      setTip(h ? { x: h.x, y: h.y, text: h.nd.label } : null);
    };
    const up = (e: PointerEvent) => {
      const p = pos(e);
      if (!moved) {
        const h = hit(p.x, p.y);
        if (h) router.push(h.nd.href);
      }
      drag = null;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", () => setTip(null));
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, height, router]);

  return (
    <div ref={wrap} className="viz-wrap" style={{ height }}>
      <canvas ref={ref} role="img" aria-label={`BINGO knowledge sphere: ${data.modules.map((m) => `${m.label} ${m.count}`).join(", ")}`} style={{ touchAction: "none", cursor: "grab" }} />
      {tip ? <div className="viz-tip" style={{ left: tip.x + 12, top: tip.y - 10 }}>{tip.text}</div> : null}
      <ul className="sr">
        {data.modules.map((m) => <li key={m.key}>{m.label}: {m.count} records, {m.bad} need attention</li>)}
      </ul>
    </div>
  );
}
