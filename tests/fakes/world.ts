/**
 * A fake "outside world" behind fetch(): Google (OAuth, Gmail, Calendar, Sheets),
 * GitHub, Vercel, Telegram, Twilio and some company websites. It implements the
 * same URL shapes as the real APIs so BINGO's clients are exercised end to end,
 * and it records every request so tests can assert on real side effects.
 */
export interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export class World {
  requests: Recorded[] = [];
  sentEmails: { id: string; threadId: string; raw: string; decoded: string }[] = [];
  threads = new Map<string, { id: string; threadId: string; internalDate: string; labelIds: string[]; payload: unknown }[]>();
  busy: { start: string; end: string }[] = [];
  events = new Map<string, { id: string; status: string; attendees: { email: string; responseStatus: string }[]; start: { dateTime: string }; end: { dateTime: string }; htmlLink: string; hangoutLink?: string }>();
  sheets = new Map<string, string[][]>(); // tab -> values
  repos = new Map<string, { refs: Map<string, string>; commits: Map<string, { tree: string; message: string; parents: string[] }>; blobs: Map<string, string>; trees: Map<string, { path: string; sha: string }[]>; pulls: { number: number; head: string; html_url: string }[] }>();
  vercelProjects = new Map<string, { id: string; name: string; env: unknown[] }>();
  deployments = new Map<string, { id: string; url: string; readyState: string; target?: string; polls: number; files: { file: string; sha: string }[] }>();
  vercelFiles = new Set<string>();
  telegram: { method: string; body: unknown }[] = [];
  calls: { to: string; twiml: string; sid: string }[] = [];
  sites = new Map<string, { status: number; html: string }>();
  private seq = 1;

  constructor() {
    this.sheets.set("Leads", [["BINGO ID", "Company", "Country", "Website", "Email", "Phone", "Language", "Stage", "Relevance", "Verification", "Sources", "Owner", "Notes", "Last Contact", "Updated", "Formula Column"]]);
  }

  id(prefix: string) {
    return `${prefix}${this.seq++}`;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body = "";
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Uint8Array) body = Buffer.from(init.body).toString("utf8");
    else if (init?.body instanceof FormData) body = JSON.stringify(Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `(file ${(v as File).name})`])));
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    this.requests.push({ method, url, body, headers });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    const p = u.pathname;
    const parsed = () => (body ? (headers["content-type"]?.includes("x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body)) : {});

    // ---------------- Google
    if (u.host === "oauth2.googleapis.com") return json({ access_token: "ya29.fake", expires_in: 3600 });
    if (u.host === "gmail.googleapis.com") {
      if (p.endsWith("/messages/send")) {
        const b = parsed();
        const id = this.id("msg");
        const threadId = b.threadId ?? this.id("thr");
        const decoded = Buffer.from(b.raw, "base64url").toString("utf8");
        this.sentEmails.push({ id, threadId, raw: b.raw, decoded });
        const t = this.threads.get(threadId) ?? [];
        t.push({ id, threadId, internalDate: String(Date.now()), labelIds: ["SENT"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "owner@carpediem.example" }, { name: "Subject", value: "sent" }], body: { data: Buffer.from("sent").toString("base64url") } } });
        this.threads.set(threadId, t);
        return json({ id, threadId, labelIds: ["SENT"] });
      }
      const tm = p.match(/\/threads\/([^/]+)$/);
      if (tm) return json({ id: tm[1], messages: this.threads.get(tm[1]!) ?? [] });
    }
    if (u.host === "www.googleapis.com" && p.startsWith("/calendar/v3")) {
      if (p.endsWith("/freeBusy")) return json({ calendars: { primary: { busy: this.busy } } });
      if (p.endsWith("/events") && method === "POST") {
        const b = parsed();
        const id = this.id("evt");
        const ev = { id, status: "confirmed", attendees: b.attendees.map((a: { email: string }) => ({ email: a.email, responseStatus: "needsAction" })), start: b.start, end: b.end, htmlLink: `https://calendar.google.com/event?eid=${id}`, hangoutLink: b.conferenceData ? `https://meet.google.com/abc-${id}` : undefined, conferenceData: b.conferenceData ? { entryPoints: [{ entryPointType: "video", uri: `https://meet.google.com/abc-${id}` }] } : undefined, query: u.search };
        this.events.set(id, ev);
        return json(ev);
      }
      const em = p.match(/\/events\/([^/]+)$/);
      if (em) return json(this.events.get(decodeURIComponent(em[1]!)));
    }
    if (u.host === "sheets.googleapis.com") {
      if (p.endsWith(":batchUpdate") && !p.includes("/values")) {
        const b = parsed();
        for (const r of b.requests) if (r.addSheet) this.sheets.set(r.addSheet.properties.title, []);
        return json({});
      }
      if (/\/spreadsheets\/[^/]+$/.test(p)) return json({ sheets: [...this.sheets.keys()].map((title) => ({ properties: { title } })) });
      const range = decodeURIComponent(p.split("/values/")[1] ?? "");
      const tab = range.replace(/^'/, "").split("'")[0]!.replace(/''/g, "'");
      if (p.endsWith("/values:batchUpdate")) {
        const b = parsed();
        for (const d of b.data) {
          const t = d.range.replace(/^'/, "").split("'")[0];
          const row = Number(d.range.match(/!A(\d+):/)[1]);
          const vals = this.sheets.get(t)!;
          const old = vals[row - 1] ?? [];
          vals[row - 1] = d.values[0].map((v: unknown, i: number) => (v === null ? (old[i] ?? "") : String(v)));
        }
        return json({});
      }
      if (p.includes(":append")) {
        const b = parsed();
        const vals = this.sheets.get(tab)!;
        for (const r of b.values) vals.push(r.map((v: unknown) => (v === null ? "" : String(v))));
        return json({});
      }
      if (method === "PUT") {
        this.sheets.set(tab, parsed().values);
        return json({});
      }
      return json({ values: this.sheets.get(tab) ?? [] });
    }

    // ---------------- GitHub
    if (u.host === "api.github.com") {
      if (p === "/user") return json({ login: "aaryansatyam4" });
      if (p === "/user/repos" && method === "POST") {
        const b = parsed();
        const full = `aaryansatyam4/${b.name}`;
        if (this.repos.has(full)) return json({ message: "name already exists" }, 422);
        const sha = this.id("c");
        this.repos.set(full, { refs: new Map([["main", sha]]), commits: new Map([[sha, { tree: "t0", message: "init", parents: [] }]]), blobs: new Map(), trees: new Map([["t0", []]]), pulls: [] });
        return json({ id: this.seq++, name: b.name, owner: { login: "aaryansatyam4" }, default_branch: "main", html_url: `https://github.com/${full}` });
      }
      const rm = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
      if (rm) {
        const repo = this.repos.get(rm[1]!);
        const rest = rm[2] ?? "";
        if (!repo) return json({ message: "Not Found" }, 404);
        let m;
        if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
          const sha = repo.refs.get(decodeURIComponent(m[1]!));
          return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
        }
        if (rest === "/git/refs" && method === "POST") {
          const b = parsed();
          repo.refs.set(b.ref.replace("refs/heads/", ""), b.sha);
          return json({ ref: b.ref });
        }
        if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
          repo.refs.set(decodeURIComponent(m[1]!), parsed().sha);
          return json({});
        }
        if ((m = rest.match(/^\/git\/commits\/(.+)$/))) return json({ tree: { sha: repo.commits.get(m[1]!)!.tree } });
        if (rest === "/git/blobs") {
          const sha = this.id("b");
          repo.blobs.set(sha, parsed().content);
          return json({ sha });
        }
        if (rest === "/git/trees") {
          const b = parsed();
          const sha = this.id("t");
          repo.trees.set(sha, [...(repo.trees.get(b.base_tree) ?? []), ...b.tree]);
          return json({ sha });
        }
        if (rest === "/git/commits" && method === "POST") {
          const b = parsed();
          const sha = this.id("c");
          repo.commits.set(sha, { tree: b.tree, message: b.message, parents: b.parents });
          return json({ sha, html_url: `https://github.com/${rm[1]}/commit/${sha}` });
        }
        if (rest.startsWith("/pulls") && method === "GET") return json(repo.pulls.filter((x) => u.searchParams.get("head")?.endsWith(`:${x.head}`)));
        if (rest === "/pulls" && method === "POST") {
          const b = parsed();
          const pr = { number: repo.pulls.length + 1, head: b.head, html_url: `https://github.com/${rm[1]}/pull/${repo.pulls.length + 1}` };
          repo.pulls.push(pr);
          return json(pr);
        }
        if (!rest) return json({ id: 1, name: rm[1]!.split("/")[1], owner: { login: rm[1]!.split("/")[0] }, default_branch: "main", html_url: `https://github.com/${rm[1]}` });
      }
    }

    // ---------------- Vercel
    if (u.host === "api.vercel.com") {
      if (p === "/v2/user") return json({ user: { username: "aaryan" } });
      const pm = p.match(/^\/v9\/projects\/([^/]+)$/);
      if (pm && method === "GET") {
        const proj = [...this.vercelProjects.values()].find((x) => x.name === decodeURIComponent(pm[1]!) || x.id === decodeURIComponent(pm[1]!));
        return proj ? json(proj) : json({ error: { code: "not_found" } }, 404);
      }
      if (p === "/v11/projects" && method === "POST") {
        const b = parsed();
        const proj = { id: this.id("prj_v"), name: b.name, env: b.environmentVariables };
        this.vercelProjects.set(proj.id, proj);
        return json(proj);
      }
      if (p === "/v2/files") {
        this.vercelFiles.add(headers["x-vercel-digest"]!);
        return json({});
      }
      if (p === "/v13/deployments" && method === "POST") {
        const b = parsed();
        for (const f of b.files) if (!this.vercelFiles.has(f.sha)) return json({ error: { code: "missing_files" } }, 400);
        const id = this.id("dpl_");
        const d = { id, url: `${b.name}-${id}.vercel.app`, readyState: "BUILDING", target: b.target, polls: 0, files: b.files };
        this.deployments.set(id, d);
        return json(d);
      }
      const dm = p.match(/^\/v13\/deployments\/([^/]+)$/);
      if (dm) {
        const d = this.deployments.get(decodeURIComponent(dm[1]!))!;
        d.polls++;
        if (d.polls >= 2) d.readyState = "READY";
        return json({ ...d, alias: d.target === "production" ? [`${d.url.split("-dpl")[0]}.vercel.app`] : [] });
      }
      if (p.match(/^\/v9\/projects\/[^/]+\/rollback\//)) return json({});
      if (p.match(/^\/v10\/projects\/[^/]+\/domains$/)) return json({ name: parsed().name, verified: false, verification: [{ type: "TXT", domain: "_vercel", value: "vc-domain-verify" }] });
    }
    if (u.host.endsWith(".vercel.app")) {
      return new Response(`<!doctype html><html lang="en"><head><title>Site</title></head><body><h1>Your evening, reimagined</h1></body></html>`, { status: 200 });
    }

    // ---------------- Telegram & Twilio
    if (u.host === "api.telegram.org") {
      const methodName = p.split("/").pop()!;
      this.telegram.push({ method: methodName, body: body ? (methodName === "sendDocument" ? body : JSON.parse(body)) : {} });
      return json({ ok: true, result: { message_id: this.seq++ } });
    }
    if (u.host === "api.twilio.com") {
      const b = Object.fromEntries(new URLSearchParams(body));
      const sid = this.id("CA");
      this.calls.push({ to: b.To!, twiml: b.Twiml!, sid });
      return json({ sid, status: "queued" });
    }

    // ---------------- Company websites
    const site = this.sites.get(u.origin + (p === "/" ? "" : p)) ?? this.sites.get(u.origin);
    if (site && (p === "/" || this.sites.has(u.origin + p))) return new Response(site.html, { status: site.status });
    if (site) return new Response("not found", { status: 404 });
    return new Response(`World has no route for ${method} ${url}`, { status: 501 });
  };

  /** Adds an inbound reply into a Gmail thread. */
  reply(threadId: string, from: string, text: string, subject = "Re: Partnership") {
    const t = this.threads.get(threadId) ?? [];
    const id = this.id("in");
    t.push({ id, threadId, internalDate: String(Date.now()), labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, { name: "Message-ID", value: `<${id}@mail>` }], body: { data: Buffer.from(text, "utf8").toString("base64url") } } });
    this.threads.set(threadId, t);
    return id;
  }
}
