/**
 * What has shipped, newest first. The landing page pill shows the newest entry and links to
 * /changelog. Add an entry when something a visitor would notice really ships; never announce
 * something that is not live.
 */
export interface ChangelogEntry {
  /** ISO date, for example "2026-09-21". */
  date: string;
  /** Short, plain-language title, shown in the pill. */
  title: string;
  /** One or two sentences: what changed for a person using it. */
  body: string;
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: "2026-09-21",
    title: "sign in with an email link",
    body: "Enter your email and we send a one-time link that works once and expires after 15 minutes. If a link has expired, the page says so and lets you ask for a new one. There is no password.",
  },
];

export function latestUpdate(): ChangelogEntry {
  return CHANGELOG[0]!;
}
