/** How a sign-in link reaches a person. Production supplies a real email
 *  provider; development and tests use a console or in-memory transport. */
export interface MagicLinkMailer {
  sendMagicLink(message: { to: string; url: string }): Promise<void>;
}

export class MailerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Sending the sign-in email did not finish within ${timeoutMs} ms`);
    this.name = "MailerTimeoutError";
  }
}

/** Fails a send that takes longer than `timeoutMs`, so a slow email provider
 *  cannot hold a sign-in request open. The timer is always cleared. */
export function withTimeout(mailer: MagicLinkMailer, timeoutMs: number): MagicLinkMailer {
  return {
    async sendMagicLink(message) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailerTimeoutError(timeoutMs)), timeoutMs);
      });
      try {
        await Promise.race([mailer.sendMagicLink(message), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Development and tests: prints the link instead of emailing it. */
export function consoleMailer(log: (line: string) => void = console.info): MagicLinkMailer {
  return {
    async sendMagicLink({ to, url }) {
      log(`[dev mailer] sign-in link for ${to}: ${url}`);
    },
  };
}

export interface ResendConfig {
  apiKey: string;
  /** The sender, for example `workspace.video <login@mail.workspace.video>`. */
  from: string;
}

const RESEND_URL = "https://api.resend.com/emails";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Sends the sign-in link through Resend's HTTP API (no client library needed).
 *  A failed send throws with the provider's status, never with the API key, and
 *  the caller (handleAuthRequest) turns that into a 503 the person can act on. */
export function resendMailer(config: ResendConfig, fetchImpl: typeof fetch = fetch): MagicLinkMailer {
  return {
    async sendMagicLink({ to, url }) {
      const text =
        `Use this link to sign in to workspace.video:\n\n${url}\n\n` +
        "It works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.";
      const html =
        `<p>Use this link to sign in to workspace.video:</p>` +
        `<p><a href="${escapeHtml(url)}">Sign in to workspace.video</a></p>` +
        `<p>It works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.</p>`;
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.from, to: [to], subject: "Your workspace.video sign-in link", text, html }),
      });
      if (!res.ok) {
        throw new Error(`Resend refused the sign-in email (HTTP ${res.status})`);
      }
    },
  };
}

/** The mailer for this environment. Development and tests print the link. Production
 *  needs the email provider's settings and refuses to start without them: nobody
 *  could sign in, and that must be a loud start-up failure, not a silent one. */
export function createMailer(options: {
  nodeEnv: string;
  log?: (line: string) => void;
  resend?: ResendConfig;
  fetchImpl?: typeof fetch;
}): MagicLinkMailer {
  if (options.nodeEnv === "production") {
    if (!options.resend?.apiKey || !options.resend.from) {
      throw new Error(
        "Refusing to start in production: no email provider is configured, so sign-in links cannot be sent. " +
          "Set RESEND_API_KEY and MAIL_FROM.",
      );
    }
    return resendMailer(options.resend, options.fetchImpl);
  }
  return consoleMailer(options.log);
}
