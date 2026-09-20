import { describe, it, expect, afterEach, vi } from "vitest";
import { withTimeout, consoleMailer, createMailer, MailerTimeoutError, type MagicLinkMailer } from "../mailer";

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
