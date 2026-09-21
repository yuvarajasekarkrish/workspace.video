/**
 * Addresses the owner may configure for links on the public pages (the demo booking page, a
 * contact email, social accounts). A link without a valid address is simply not drawn, so
 * the page never shows a dead button. Only https addresses are accepted, so a mistyped or
 * malicious value cannot become a "javascript:" or plain-http link.
 */

export function optionalHttpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

const SIMPLE_EMAIL = /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/;

export function optionalEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && SIMPLE_EMAIL.test(trimmed) ? trimmed : undefined;
}

const SOCIAL: { label: string; variable: string }[] = [
  { label: "X", variable: "SOCIAL_X_URL" },
  { label: "Instagram", variable: "SOCIAL_INSTAGRAM_URL" },
  { label: "LinkedIn", variable: "SOCIAL_LINKEDIN_URL" },
];

export function socialLinksFrom(source: Readonly<Record<string, string | undefined>>): { label: string; href: string }[] {
  const links: { label: string; href: string }[] = [];
  for (const { label, variable } of SOCIAL) {
    const href = optionalHttpsUrl(source[variable]);
    if (href) links.push({ label, href });
  }
  return links;
}
