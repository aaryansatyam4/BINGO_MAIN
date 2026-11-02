import { cookies } from "next/headers";

/** CSRF protection for OAuth: random state stored in an httpOnly cookie. */
export async function newState(provider: string) {
  const state = crypto.randomUUID();
  (await cookies()).set(`oauth_${provider}`, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  return state;
}

export async function checkState(provider: string, state: string | null) {
  const jar = await cookies();
  const want = jar.get(`oauth_${provider}`)?.value;
  jar.delete(`oauth_${provider}`);
  return !!state && !!want && state === want;
}
