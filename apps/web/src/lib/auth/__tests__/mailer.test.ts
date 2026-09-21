import { describe, it, expect, afterEach, vi } from "vitest";
import { withTimeout, consoleMailer, createMailer, resendMailer, MailerTimeoutError, type MagicLinkMailer } from "../mailer";

const MSG = { to: "a@example.com", url: "https://app.example/api/auth/magic-link/verify?token=t" };

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes a fast send through and leaves no timer running", async () => {
    vi.useFakeTimers();
    const inner: MagicLinkMailer = { sendMagicLink: vi.fn().mockResolvedValue(undefined) };
    await withTimeout(inner, 5_000).sendMagicLink(MSG);
    expect(inner.sendMagicLink).toHaveBeenCalledWith(MSG);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with MailerTimeoutError when the provider never answers", async () => {
    vi.useFakeTimers();
    const inner: MagicLinkMailer = { sendMagicLink: () => new Promise<void>(() => {}) };
    const pending = withTimeout(inner, 5_000).sendMagicLink(MSG);
    const assertion = expect(pending).rejects.toBeInstanceOf(MailerTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-throws the provider's own error and leaves no timer running", async () => {
    vi.useFakeTimers();
    const boom = new Error("provider down");
    const inner: MagicLinkMailer = { sendMagicLink: vi.fn().mockRejectedValue(boom) };
    await expect(withTimeout(inner, 5_000).sendMagicLink(MSG)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("consoleMailer", () => {
  it("logs the recipient and link, and sends nothing", async () => {
    const log = vi.fn();
    await consoleMailer(log).sendMagicLink(MSG);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain(MSG.to);
    expect(log.mock.calls[0]![0]).toContain(MSG.url);
  });
});

describe("createMailer", () => {
  it("uses the console mailer in development and test", () => {
    for (const nodeEnv of ["development", "test"]) {
      const log = vi.fn();
      void createMailer({ nodeEnv, log }).sendMagicLink(MSG);
      expect(log, nodeEnv).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses to start in production until a real email provider is configured, and says so", () => {
    expect(() => createMailer({ nodeEnv: "production" })).toThrow(/email provider/i);
  });
});

describe("resendMailer", () => {
  const CONFIG = { apiKey: "re_test_key_123", from: "workspace.video <login@mail.workspace.video>" };
  const okFetch = () => vi.fn().mockResolvedValue({ ok: true, status: 200 });

  it("posts the link to Resend with the key in the Authorization header only", async () => {
    const fetchImpl = okFetch();
    await resendMailer(CONFIG, fetchImpl as unknown as typeof fetch).sendMagicLink(MSG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key_123");
    const body = JSON.parse(init.body);
    expect(body.to).toEqual([MSG.to]);
    expect(body.from).toBe(CONFIG.from);
    expect(body.text).toContain(MSG.url);
    expect(init.body).not.toContain("re_test_key_123");
  });

  it("escapes the link inside the HTML body", async () => {
    const fetchImpl = okFetch();
    const url = "https://app.example/verify?token=t&callbackURL=%2F";
    await resendMailer(CONFIG, fetchImpl as unknown as typeof fetch).sendMagicLink({ to: MSG.to, url });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.html).toContain("token=t&amp;callbackURL=%2F");
    expect(body.text).toContain(url);
  });

  it("throws with the HTTP status, and never the API key, when Resend refuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const err = await resendMailer(CONFIG, fetchImpl as unknown as typeof fetch)
      .sendMagicLink(MSG)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("re_test_key_123");
  });

  it("passes a network failure through", async () => {
    const boom = new Error("network down");
    const fetchImpl = vi.fn().mockRejectedValue(boom);
    await expect(resendMailer(CONFIG, fetchImpl as unknown as typeof fetch).sendMagicLink(MSG)).rejects.toBe(boom);
  });
});

describe("createMailer with a provider", () => {
  const RESEND = { apiKey: "re_test_key_123", from: "workspace.video <login@mail.workspace.video>" };

  it("uses Resend in production when both settings are present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await createMailer({ nodeEnv: "production", resend: RESEND, fetchImpl: fetchImpl as unknown as typeof fetch }).sendMagicLink(MSG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still refuses in production when the key or the sender is blank", () => {
    expect(() => createMailer({ nodeEnv: "production", resend: { ...RESEND, apiKey: "" } })).toThrow(/RESEND_API_KEY/);
    expect(() => createMailer({ nodeEnv: "production", resend: { ...RESEND, from: "" } })).toThrow(/MAIL_FROM/);
  });

  it("never sends real email outside production, even with a key set", async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();
    await createMailer({ nodeEnv: "development", log, resend: RESEND, fetchImpl: fetchImpl as unknown as typeof fetch }).sendMagicLink(MSG);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
