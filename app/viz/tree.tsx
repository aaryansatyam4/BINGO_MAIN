"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { VizData, VizNode } from "@/web/viz-data";

/**
 * BINGO system tree: the trunk is BINGO, each main branch a module, each leaf a
 * real record (green = done, red = needs attention, amber = waiting, cyan =
 * info). Branches carrying problems glow red. The roots feed a live activity
 * chart for the last 72 hours.
 */
const W = 1200;
const H = 800;
const TONE: Record<string, string> = { good: "#39ff9c", bad: "#ff3b5c", warn: "#ffb020", info: "#38d6ff" };

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

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  depth: number;
  mod: number;
  parent: number;
  bad: boolean;
  good: boolean;
}

export function SystemTree({ data }: { data: VizData }) {
  const geo = useMemo(() => {
    const r = rng(7);
    const segs: Seg[] = [];
    const tips: { x: number; y: number; mod: number; seg: number }[][] = data.modules.map(() => []);
    const baseX = W / 2;
    const baseY = 585;
    const topY = 410;
    segs.push({ x1: baseX, y1: baseY, x2: baseX, y2: topY, w: 26, depth: 0, mod: -1, parent: -1, bad: false, good: false });
    const grow = (x: number, y: number, ang: number, len: number, w: number, depth: number, mod: number, parent: number) => {
      const x2 = x + Math.cos(ang) * len;
      const y2 = y + Math.sin(ang) * len;
      const idx = segs.push({ x1: x, y1: y, x2, y2, w, depth, mod, parent, bad: false, good: false }) - 1;
      if (depth >= 6) {
        tips[mod]!.push({ x: x2, y: y2, mod, seg: idx });
        return;
      }
      const k = depth < 3 ? 2 : r() < 0.6 ? 2 : 3;
      for (let i = 0; i < k; i++) {
        const spread = 0.28 + r() * 0.26;
        const a = ang + (i - (k - 1) / 2) * spread + (r() - 0.5) * 0.16;
        grow(x2, y2, a, len * (0.66 + r() * 0.1), Math.max(0.7, w * 0.64), depth + 1, mod, idx);
      }
    };
    const n = data.modules.length;
    data.modules.forEach((_, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const ang = -Math.PI + 0.55 + t * (Math.PI - 1.1);
      const startY = topY + 30 - Math.sin(t * Math.PI) * 30;
      grow(baseX, startY, ang + (r() - 0.5) * 0.08, 78 + r() * 18, 10, 1, i, 0);
    });
    const mark = (seg: number, key: "bad" | "good") => {
      for (let s = seg; s > 0; s = segs[s]!.parent) {
        if (segs[s]![key]) break;
        segs[s]![key] = true;
      }
    };
    const leaves: { x: number; y: number; nd: VizNode; delay: number }[] = [];
    data.modules.forEach((m, i) => {
      const own = data.nodes.filter((nd) => nd.group === m.key).slice(0, 64);
      const t = tips[i]!;
      // Spread records across the module's tips instead of piling on the first ones.
      const order = t.map((_, k) => k).sort((a, b) => ((a * 7919) % t.length) - ((b * 7919) % t.length));
      own.forEach((nd, j) => {
        const tip = t[order[j % t.length]!]!;
        const ring = Math.floor(j / t.length);
        const a = r() * Math.PI * 2;
        leaves.push({ x: tip.x + Math.cos(a) * (2 + ring * 6), y: tip.y + Math.sin(a) * (2 + ring * 6), nd, delay: r() * 4 });
        if (nd.tone === "bad") mark(tip.seg, "bad");
        if (nd.tone === "good") mark(tip.seg, "good");
      });
    });
    const roots: string[] = [];
    for (let i = 0; i < 11; i++) {
      const dx = (i - 5) * 46 + (r() - 0.5) * 20;
      const endX = baseX + dx * 2.2;
      roots.push(`M ${baseX + dx * 0.22} ${baseY - 4} C ${baseX + dx * 0.6} ${baseY + 26}, ${endX} ${baseY + 18}, ${endX + (r() - 0.5) * 30} 640`);
    }
    const circuits: string[] = [];
    for (let i = 0; i < 6; i++) {
      const x = baseX - 10 + i * 4;
      circuits.push(`M ${x} ${baseY} L ${x} ${topY + 30 + r() * 60} L ${x + (r() - 0.5) * 26} ${topY - 6 - r() * 30}`);
    }
    return { segs, tips, leaves, roots, circuits };
  }, [data]);

  const hist = data.histogram;
  const max = Math.max(1, ...hist.map((b) => b.good + b.bad + b.info));
  const chartX = 60;
  const chartW = W - 120;
  const chartTop = 650;
  const chartH = 110;
  const bw = chartW / hist.length;

  // Module label anchors: the first segment end of each main branch.
  const labelAt = data.modules.map((_, i) => geo.segs.find((s) => s.mod === i && s.depth === 1)!);

  return (
    <div className="viz-wrap tree">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="BINGO system tree: modules, records and activity">
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow2" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <linearGradient id="trunk" x1="0" x2="1">
            <stop offset="0" stopColor="#1c232c" />
            <stop offset="0.5" stopColor="#5d6875" />
            <stop offset="1" stopColor="#1c232c" />
          </linearGradient>
        </defs>

        {/* HUD stats strip */}
        <g className="hud" fontFamily="'JetBrains Mono', ui-monospace, monospace">
          <text x={40} y={44} fill="#f2f7ff" fontSize="20" fontWeight="700" letterSpacing="4">BINGO · SYSTEM TREE</text>
          <line x1={40} x2={W - 40} y1={58} y2={58} stroke="rgba(160,190,230,.25)" />
          {data.stats.map((s, i) => (
            <g key={s.label} transform={`translate(${40 + i * ((W - 80) / data.stats.length)}, 92)`}>
              <text fill="#39ff9c" fontSize="24" fontWeight="700" filter="url(#glow)">{s.value}</text>
              <text y={18} fill="rgba(160,190,230,.8)" fontSize="10.5" letterSpacing="2">{s.label}</text>
            </g>
          ))}
        </g>

        {/* Roots and circuits */}
        <g fill="none" strokeLinecap="round">
          {geo.roots.map((d, i) => <path key={i} d={d} stroke={i % 3 === 0 ? "#2d7bff" : "#7f8a96"} strokeOpacity={0.55} strokeWidth={1.2} className="draw" />)}
          {geo.circuits.map((d, i) => <path key={i} d={d} stroke={i % 2 ? "#ffd84a" : "#38d6ff"} strokeOpacity={0.7} strokeWidth={0.8} filter="url(#glow)" />)}
        </g>

        {/* Branches */}
        <g strokeLinecap="round" fill="none">
          {geo.segs.map((s, i) => {
            const red = s.bad && s.depth >= 2;
            const green = !red && s.good && s.depth >= 3;
            return (
              <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.depth === 0 ? "url(#trunk)" : red ? "#ff3b5c" : green ? "#2ee58a" : s.depth <= 2 ? "#6f7b88" : "#8d9cad"} strokeOpacity={red ? 0.95 : green ? 0.75 : s.depth <= 2 ? 0.9 : 0.45} strokeWidth={red ? Math.max(1, s.w) : s.w} filter={red ? "url(#glow)" : undefined} className="draw" style={{ animationDelay: `${s.depth * 0.18}s` }} />
            );
          })}
        </g>

        {/* Buds where a module has no records yet */}
        {data.modules.map((m, i) => (m.count ? null : geo.tips[i]!.slice(0, 10).map((t, k) => <circle key={`${i}-${k}`} cx={t.x} cy={t.y} r={1.6} fill="#3a4654" />)))}

        {/* Leaves = real records */}
        <g>
          {geo.leaves.map((l) => (
            <Link key={l.nd.id} href={l.nd.href}>
              <circle cx={l.x} cy={l.y} r={l.nd.tone === "bad" ? 4.6 : 3.6} fill={TONE[l.nd.tone]} filter="url(#glow)" className="leaf" style={{ animationDelay: `${l.delay}s` }}>
                <title>{l.nd.label}</title>
              </circle>
            </Link>
          ))}
        </g>

        {/* Module labels with leader lines */}
        <g fontFamily="'JetBrains Mono', ui-monospace, monospace">
          {data.modules.map((m, i) => {
            const s = labelAt[i];
            if (!s) return null;
            const left = s.x2 < W / 2;
            const lx = left ? 40 : W - 40;
            const ly = 150 + (left ? i : data.modules.length - 1 - i) * 40;
            return (
              <Link key={m.key} href={m.href}>
                <g className="mod-label">
                  <polyline points={`${s.x2},${s.y2} ${left ? lx + 150 : lx - 150},${ly} ${lx},${ly}`} fill="none" stroke="rgba(160,190,230,.35)" strokeWidth={0.8} />
                  <circle cx={s.x2} cy={s.y2} r={2.5} fill="#f2f7ff" />
                  <text x={lx} y={ly - 6} textAnchor={left ? "start" : "end"} fill="#f2f7ff" fontSize="12.5" fontWeight="700" letterSpacing="2">{m.label}</text>
                  <text x={lx} y={ly + 12} textAnchor={left ? "start" : "end"} fontSize="10.5" letterSpacing="1">
                    <tspan fill="rgba(160,190,230,.85)">{m.count} </tspan>
                    <tspan fill="#39ff9c">▲{m.good} </tspan>
                    <tspan fill={m.bad ? "#ff3b5c" : "rgba(160,190,230,.5)"}>▼{m.bad}</tspan>
                  </text>
                </g>
              </Link>
            );
          })}
        </g>

        {/* Activity chart at the roots */}
        <g fontFamily="'JetBrains Mono', ui-monospace, monospace">
          <text x={chartX} y={chartTop - 14} fill="#f2f7ff" fontSize="11" letterSpacing="2">ACTIVITY · 72H</text>
          <text x={chartX + chartW} y={chartTop - 14} fill="rgba(160,190,230,.8)" fontSize="10.5" textAnchor="end" letterSpacing="1">
            <tspan fill="#39ff9c">■ success </tspan><tspan fill="#ff3b5c">■ errors/warnings </tspan><tspan fill="#38d6ff">■ info</tspan>
          </text>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={chartX} x2={chartX + chartW} y1={chartTop + chartH * f} y2={chartTop + chartH * f} stroke="rgba(160,190,230,.1)" />)}
          {hist.map((b, i) => {
            const x = chartX + i * bw + 1.5;
            const hg = (b.good / max) * chartH;
            const hb = (b.bad / max) * chartH;
            const hi = (b.info / max) * chartH;
            const y0 = chartTop + chartH;
            return (
              <g key={i}>
                <rect x={x} y={y0 - hg} width={bw - 3} height={hg} fill="#39ff9c" opacity={0.85} />
                <rect x={x} y={y0 - hg - hi} width={bw - 3} height={hi} fill="#38d6ff" opacity={0.55} />
                <rect x={x} y={y0 - hg - hi - hb} width={bw - 3} height={hb} fill="#ff3b5c" opacity={0.95} filter={hb ? "url(#glow)" : undefined} />
                <title>{`${b.label}:00 — ${b.good} success, ${b.bad} errors/warnings, ${b.info} info`}</title>
                {i % 6 === 0 ? <text x={x} y={y0 + 16} fill="rgba(160,190,230,.65)" fontSize="9.5">{b.label}h</text> : null}
              </g>
            );
          })}
          <line x1={chartX} x2={chartX + chartW} y1={chartTop + chartH} y2={chartTop + chartH} stroke="rgba(160,190,230,.4)" />
        </g>
      </svg>
    </div>
  );
}
