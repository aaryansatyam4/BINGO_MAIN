"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { login } from "../actions";

function LoginForm() {
  const [state, action, pending] = useActionState(login, {} as { error?: string });
  const next = useSearchParams().get("next") ?? "/";
  return (
    <form action={action} className="card" style={{ width: 360 }}>
      <div className="brand" style={{ padding: "0 0 16px" }}>
        <span className="orb" aria-hidden="true" /> BINGO
      </div>
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="pw">Owner password</label>
        <input id="pw" name="password" type="password" autoComplete="current-password" required autoFocus />
      </div>
      {state?.error ? <p className="notice bad">{state.error}</p> : null}
      <button className="btn primary" style={{ width: "100%" }} disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
