"use client";

import { usePathname, useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { ask } from "./actions";

export function AutoRefresh({ ms = 4000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [ms, router]);
  return null;
}

export function Submit({ children, className = "btn primary", pending = "Working…", name, value, confirm: confirmText }: { children: React.ReactNode; className?: string; pending?: string; name?: string; value?: string; confirm?: string }) {
  const { pending: busy } = useFormStatus();
  return (
    <button
      className={className}
      type="submit"
      name={name}
      value={value}
      disabled={busy}
      onClick={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {busy ? pending : children}
    </button>
  );
}

const EXAMPLES = [
  "Create a premium SleepTime landing page and deploy a preview",
  "Find 30 pharmaceutical distributors in Uzbekistan and prepare our outreach in Russian",
  "Create five premium advertising creatives for Carpediem SleepTime",
  "Make a complete expansion report for Cambodia and send it to my Gmail and Telegram",
  "Arrange meetings next week with the distributors who responded positively",
  "Call me immediately for all major business emergencies, but send routine matters to Telegram",
];

export function AskBox({ big = false }: { big?: boolean }) {
  const [state, action] = useActionState(ask, {} as { notes?: string[]; error?: string });
  const [text, setText] = useState("");
  return (
    <div>
      <form action={action} className={`ask ${big ? "big" : ""}`}>
        {big ? (
          <textarea name="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Give BINGO a business objective…" aria-label="Ask BINGO" required onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }} />
        ) : (
          <input name="text" placeholder="Ask BINGO…" aria-label="Ask BINGO" required />
        )}
        <Submit pending="Planning…">Ask BINGO</Submit>
      </form>
      {state?.error ? <p className="notice bad" style={{ marginTop: 10 }}>{state.error}</p> : null}
      {state?.notes?.length ? <div className="notice" style={{ marginTop: 10 }}>{state.notes.map((n, i) => <p key={i} style={{ margin: 0 }}>{n}</p>)}</div> : null}
      {big ? (
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className="btn sm chip" onClick={() => setText(e)}>{e.length > 58 ? `${e.slice(0, 56)}…` : e}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Exports an SVG creative as PNG in the browser (fonts and images already embedded). */
export function ExportPng({ src, name, width, height }: { src: string; name: string; width: number; height: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const svg = await (await fetch(src)).text();
          const img = new Image();
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
          const a = document.createElement("a");
          a.href = canvas.toDataURL("image/png");
          a.download = `${name}.png`;
          a.click();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Exporting…" : "PNG"}
    </button>
  );
}

/** Compact Ask bar on every page except Home (which has the large one). */
export function TopAsk() {
  const path = usePathname();
  if (path === "/") return null;
  return (
    <div className="top">
      <AskBox />
    </div>
  );
}
