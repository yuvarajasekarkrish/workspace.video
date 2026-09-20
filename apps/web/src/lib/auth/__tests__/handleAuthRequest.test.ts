import { describe, it, expect, vi } from "vitest";
import { handleAuthRequest } from "../handleAuthRequest";
import { SlidingWindowLimiter } from "../emailLimiter";

const BASE = "http://localhost:3000";
const requestLink = (email: unknown, extra: RequestInit = {}) =>
  new Request(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: typeof email === "string" && email.startsWith("{") ? email : JSON.stringify({ email }),
    ...extra,
  });

function setup(handler: (req: Request) => Promise<Response> | Response, max = 3) {
  const auth = { handler: vi.fn(async (req: Request) => handler(req)) };
  const emailLimiter = new SlidingWindowLimiter({ max, windowMs: 600_000 });
  const run = (req: Request) => handleAuthRequest(auth, req, { emailLimiter, baseURL: BASE });
  return { auth, run };
}

describe("handleAuthRequest: request-a-link", () => {
  it("passes the request to the auth handler with its body intact", async () => {
    let seen: unknown;
    const { run } = setup(async (req) => {
      seen = await req.json();
      return Response.json({ status: true });
    });
    const res = await run(requestLink("a@example.com"));
    expect(res.status).toBe(200);
    expect(seen).toEqual({ email: "a@example.com" });
  });

  it("refuses with 429, a message and Retry-After once one email exceeds its limit, without calling the handler", async () => {
    const { auth, run } = setup(() => Response.json({ status: true }), 2);
    await run(requestLink("a@example.com"));
    await run(requestLink("a@example.com"));
    const res = await run(requestLink("a@example.com"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("too_many_requests");
    expect(body.message).toMatch(/try again/i);
    expect(auth.handler).toHaveBeenCalledTimes(2);
  });

  it("treats the same email in different letter case or with spaces as one address", async () => {
    const { run } = setup(() => Response.json({ status: true }), 2);
    await run(requestLink("A@Example.com"));
    await run(requestLink("  a@example.COM "));
    expect((await run(requestLink("a@example.com"))).status).toBe(429);
  });

  it("limits each email separately", async () => {
    const { run } = setup(() => Response.json({ status: true }), 1);
    expect((await run(requestLink("a@example.com"))).status).toBe(200);
    expect((await run(requestLink("b@example.com"))).status).toBe(200);
  });

  it("answers a limited unknown email the same way as a limited known one (no enumeration)", async () => {
    const { run } = setup(() => Response.json({ status: true }), 1);
    await run(requestLink("known@example.com"));
    await run(requestLink("nobody@example.com"));
    const a = await run(requestLink("known@example.com"));
    const b = await run(requestLink("nobody@example.com"));
    expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
  });

  it("maps a server error from the email step to a clear 503 without leaking details", async () => {
    const { run } = setup(() => new Response("", { status: 500 }));
    const res = await run(requestLink("a@example.com"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("send_failed");
    expect(body.message).toMatch(/couldn.t send/i);
    expect(JSON.stringify(body)).not.toMatch(/provider|stack|Error:/);
  });

  it("does not count a request with no readable email, and lets the handler answer it", async () => {
    const { auth, run } = setup(() => Response.json({ code: "VALIDATION_ERROR" }, { status: 400 }), 1);
    for (const body of ["{}", "{not json", JSON.stringify({ email: 42 })]) {
      const res = await run(requestLink(body));
      expect(res.status).toBe(400);
    }
    expect(auth.handler).toHaveBeenCalledTimes(3);
  });
});

describe("handleAuthRequest: redirects only ever go to this app", () => {
  const evil = [
    "https://evil.example/steal",
    "http://localhost:3001/other-port",
    "//evil.example/steal",
    "/\\evil.example/steal",
    "javascript:alert(1)",
  ];
  const fine = ["/", "/room/abc?x=1", `${BASE}/welcome`];

  it.each(["callbackURL", "newUserCallbackURL", "errorCallbackURL"])("refuses a %s that points elsewhere, before anything is sent", async (field) => {
    for (const bad of evil) {
      const { auth, run } = setup(() => Response.json({ status: true }));
      const res = await run(requestLink(JSON.stringify({ email: "a@example.com", [field]: bad })));
      expect(res.status, `${field}=${bad}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_callback");
      expect(auth.handler).not.toHaveBeenCalled();
    }
  });

  it("refuses a callback that is not a string", async () => {
    const { run } = setup(() => Response.json({ status: true }));
    const res = await run(requestLink(JSON.stringify({ email: "a@example.com", callbackURL: 42 })));
    expect(res.status).toBe(400);
  });

  it("accepts this app's own paths and addresses", async () => {
    for (const ok of fine) {
      const { run } = setup(() => Response.json({ status: true }));
      const res = await run(requestLink(JSON.stringify({ email: "a@example.com", callbackURL: ok })));
      expect(res.status, ok).toBe(200);
    }
  });

  it("refuses a link-verify URL whose redirect parameters point elsewhere, so an error can't bounce a visitor to another site", async () => {
    for (const field of ["callbackURL", "newUserCallbackURL", "errorCallbackURL"]) {
      const { auth, run } = setup(() => new Response(null, { status: 302 }));
      const res = await run(new Request(`${BASE}/api/auth/magic-link/verify?token=t&${field}=${encodeURIComponent("https://evil.example/x")}`));
      expect(res.status, field).toBe(400);
      expect(auth.handler).not.toHaveBeenCalled();
    }
  });

  it("lets a link-verify URL with this app's own redirect parameters through", async () => {
    const { run } = setup(() => new Response(null, { status: 302, headers: { location: "/" } }));
    const res = await run(new Request(`${BASE}/api/auth/magic-link/verify?token=t&callbackURL=%2F&errorCallbackURL=%2Flogin`));
    expect(res.status).toBe(302);
  });
});

describe("handleAuthRequest: everything else is untouched", () => {
  it("passes other paths through, including their errors, and never rate-limits them", async () => {
    const { auth, run } = setup(() => new Response("boom", { status: 500 }), 1);
    for (let i = 0; i < 5; i++) {
      const res = await run(new Request(`${BASE}/api/auth/sign-out`, { method: "POST", headers: { origin: BASE } }));
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("boom");
    }
    expect(auth.handler).toHaveBeenCalledTimes(5);
  });

  it("passes the link-verify request through unchanged", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "/" } });
    const { run } = setup(() => redirect);
    const res = await run(new Request(`${BASE}/api/auth/magic-link/verify?token=t&callbackURL=%2F`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
