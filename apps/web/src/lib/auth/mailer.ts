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

/** The mailer for this environment. Production has no real email provider wired
 *  yet, so it refuses rather than pretending to send: nobody could sign in, and
 *  that must be a loud start-up failure, not a silent one. */
export function createMailer(options: { nodeEnv: string; log?: (line: string) => void }): MagicLinkMailer {
  if (options.nodeEnv === "production") {
    throw new Error(
      "Refusing to start in production: no email provider is configured, so sign-in links cannot be sent. " +
        "Add a provider transport in lib/auth/mailer.ts and select it here.",
    );
  }
  return consoleMailer(options.log);
}
