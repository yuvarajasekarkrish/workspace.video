// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@workspace-video/db";
import { createAuth } from "../auth";
import { handleAuthRequest } from "../handleAuthRequest";
import { SlidingWindowLimiter } from "../emailLimiter";

/** Real Postgres (the local docker one, or CI's), real Better Auth, an in-memory mailer.
 *  Every account these tests create ends in @it.invalid and is removed afterwards. */

const DOMAIN = "@it.invalid";
const BASE = "http://localhost:3000";
const SECRET = "integration-test-secret-0123456789abcdef0123456789abcdef";
const SEVEN_DAYS = 60 * 60 * 24 * 7;

let counter = 0;
const uniqueEmail = (label = "u") => `${label}-${Date.now()}-${counter++}${DOMAIN}`;

type Sent = { to: string; url: string };

function makeAuth(opts: { baseURL?: string; rateLimit?: { enabled: boolean; window: number; max: number } } = {}) {
  const sent: Sent[] = [];
  const baseURL = opts.baseURL ?? BASE;
  const auth = createAuth({
    prisma,
    secret: SECRET,
    baseURL,
    rateLimit: opts.rateLimit ?? { enabled: false, window: 60, max: 5 },
    mailer: {
      async sendMagicLink(message) {
        sent.push(message);
      },
    },
  });
  return { auth, sent, baseURL };
}

type Ctx = ReturnType<typeof makeAuth>;

/** Everything goes through handleAuthRequest, the same entry the real route uses. */
const through = (c: Ctx, req: Request) =>
  handleAuthRequest(c.auth, req, { emailLimiter: new SlidingWindowLimiter({ max: 1000, windowMs: 60_000 }), baseURL: c.baseURL });

const requestLink = (c: Ctx, email: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  through(
    c,
    new Request(`${c.baseURL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: c.baseURL, ...headers },
      body: JSON.stringify({ email, callbackURL: "/", ...body }),
    }),
  );

const openLink = (c: Ctx, url: string) => through(c, new Request(url));

/** "name=value; name2=value2" for every cookie a response sets. */
const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => /session_token=[^;]+/.test(c));

const sessionUser = (c: Ctx, cookie: string) => c.auth.api.getSession({ headers: new Headers({ cookie }) });

/** Requests a link for `email`, opens it, and returns the sign-in response. */
async function signIn(c: Ctx, email: string) {
  await requestLink(c, email);
  const url = c.sent.at(-1)!.url;
  return { url, response: await openLink(c, url) };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await prisma.verification.deleteMany({ where: { value: { contains: DOMAIN } } });
  await prisma.$disconnect();
});

describe("requesting a sign-in link", () => {
  let c: Ctx;
  beforeEach(() => {
    c = makeAuth();
  });

  it("answers 200 {status:true}, sends exactly one link to that address, on this app's origin", async () => {
    const email = uniqueEmail();
    const res = await requestLink(c, email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.to).toBe(email);
    const url = new URL(c.sent[0]!.url);
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe("/api/auth/magic-link/verify");
  });

  it("stores the token hashed: the database never holds the token that was emailed", async () => {
    const email = uniqueEmail();
    await requestLink(c, email);
    const token = new URL(c.sent[0]!.url).searchParams.get("token")!;
    const rows = await prisma.verification.findMany({ where: { value: { contains: email } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).not.toBe(token);
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("gives the same answer for an address that has an account and one that does not (no account enumeration)", async () => {
    const known = uniqueEmail("known");
    await signIn(c, known);
    const a = await requestLink(c, known);
    const b = await requestLink(c, uniqueEmail("nobody"));
    expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
  });

  it("rejects an invalid address with 400 and sends nothing", async () => {
    const res = await requestLink(c, "not-an-email");
    expect(res.status).toBe(400);
    expect(c.sent).toHaveLength(0);
  });

  it("limits requests per address: the sixth in a minute from one address is refused, another address is not", async () => {
    const limited = makeAuth({ rateLimit: { enabled: true, window: 60, max: 5 } });
    const from = { "x-forwarded-for": "203.0.113.7" };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestLink(limited, uniqueEmail(), {}, from)).status);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect((await requestLink(limited, uniqueEmail(), {}, { "x-forwarded-for": "203.0.113.8" })).status).toBe(200);
  });
});

describe("opening a sign-in link", () => {
  let c: Ctx;
  beforeEach(() => {
    c = makeAuth();
  });

  it("creates a verified account and a 7-day session, sets an httpOnly same-site cookie, and redirects to the callback", async () => {
    const email = uniqueEmail();
    const { response } = await signIn(c, email);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${BASE}/`);
    const cookie = sessionCookie(response)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(new RegExp(`Max-Age=${SEVEN_DAYS}`));
    expect(cookie).not.toMatch(/;\s*Secure/i);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.emailVerified).toBe(true);
    const session = await prisma.session.findFirst({ where: { userId: user!.id } });
    expect(session!.expiresAt.getTime() - Date.now()).toBeGreaterThan((SEVEN_DAYS - 60) * 1000);
    expect((await sessionUser(c, cookieHeader(response)))?.user.email).toBe(email);
  });

  it("works from a different browser than the one that asked (the link needs no cookie)", async () => {
    await requestLink(c, uniqueEmail());
    const res = await openLink(c, c.sent[0]!.url); // a fresh request, no cookies at all
    expect(res.status).toBe(302);
    expect(sessionCookie(res)).toBeDefined();
  });

  it("signs an existing account in, without creating a second one, whatever the letter case", async () => {
    const email = uniqueEmail("case");
    await signIn(c, email);
    const before = await prisma.user.findUnique({ where: { email } });
    const second = makeAuth();
    const { response } = await signIn(second, email.toUpperCase());
    expect(sessionCookie(response)).toBeDefined();
    expect(await prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } })).toBe(1);
    expect((await sessionUser(second, cookieHeader(response)))?.user.id).toBe(before!.id);
  });

  it("refuses to use the same link twice", async () => {
    const { url } = await signIn(c, uniqueEmail());
    const again = await openLink(c, url);
    expect(sessionCookie(again)).toBeUndefined();
    expect(again.headers.get("location")).toContain("error=INVALID_TOKEN");
  });

  it("gives exactly one session when the link is opened twice at the same moment (double click)", async () => {
    await requestLink(c, uniqueEmail());
    const [a, b] = await Promise.all([openLink(c, c.sent[0]!.url), openLink(c, c.sent[0]!.url)]);
    expect([a, b].filter((r) => sessionCookie(r)).length).toBe(1);
  });

  it("refuses a link whose token was altered", async () => {
    await requestLink(c, uniqueEmail());
    const res = await openLink(c, c.sent[0]!.url.replace(/token=[^&]+/, "token=not-the-token"));
    expect(sessionCookie(res)).toBeUndefined();
    expect(res.headers.get("location")).toContain("error=INVALID_TOKEN");
  });

  it("refuses an expired link", async () => {
    const email = uniqueEmail();
    await requestLink(c, email);
    await prisma.verification.updateMany({ where: { value: { contains: email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await openLink(c, c.sent[0]!.url);
    expect(sessionCookie(res)).toBeUndefined();
    expect(res.headers.get("location")).toMatch(/error=/);
  });

  it("does not let a link send anyone to another site: such a request is refused and no email is sent", async () => {
    const res = await requestLink(c, uniqueEmail(), { callbackURL: "https://evil.example/steal" });
    expect(res.status).toBe(400);
    expect(c.sent).toHaveLength(0);
  });

  it("does not bounce a visitor to another site through the error redirect of a link", async () => {
    await requestLink(c, uniqueEmail());
    const tampered = `${c.sent[0]!.url.replace(/token=[^&]+/, "token=nope")}&errorCallbackURL=${encodeURIComponent("https://evil.example/x")}`;
    const res = await openLink(c, tampered);
    expect(res.status).toBe(400);
    expect(res.headers.get("location") ?? "").not.toContain("evil.example");
  });
});

describe("cookies over https", () => {
  it("marks the session cookie Secure when the app's address is https", async () => {
    const c = makeAuth({ baseURL: "https://app.example.test" });
    const { response } = await signIn(c, uniqueEmail());
    const cookie = sessionCookie(response)!;
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});

describe("signing out", () => {
  it("revokes the session: the row is deleted and the same cookie stops working", async () => {
    const c = makeAuth();
    const email = uniqueEmail();
    const { response } = await signIn(c, email);
    const cookie = cookieHeader(response);
    const user = await prisma.user.findUnique({ where: { email } });
    expect(await prisma.session.count({ where: { userId: user!.id } })).toBe(1);

    const out = await c.auth.handler(
      new Request(`${BASE}/api/auth/sign-out`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: "{}" }),
    );

    expect(out.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user!.id } })).toBe(0);
    expect(await sessionUser(c, cookie)).toBeNull();
  });
});
