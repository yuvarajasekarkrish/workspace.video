import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ChangelogPage, { metadata as changelogMeta } from "../changelog/page";
import TermsPage, { metadata as termsMeta } from "../terms/page";
import PrivacyPage, { metadata as privacyMeta } from "../privacy/page";
import { CHANGELOG } from "@/lib/changelog";

afterEach(cleanup);

describe("/changelog", () => {
  it("lists every entry, newest first, with its date", () => {
    render(<ChangelogPage />);
    expect(screen.getByRole("heading", { level: 1, name: /changelog/i })).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toHaveLength(CHANGELOG.length);
    for (const entry of CHANGELOG) expect(screen.getByText(entry.date)).toBeTruthy();
    const dates = CHANGELOG.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("links back to the home page and has a page title", () => {
    render(<ChangelogPage />);
    expect(screen.getByRole("link", { name: /workspace\.video/i }).getAttribute("href")).toBe("/");
    expect(String(changelogMeta.title)).toMatch(/changelog/i);
  });
});

describe("/terms and /privacy (drafts for a lawyer to review)", () => {
  it("say plainly that they are drafts that have not been reviewed by a lawyer", () => {
    for (const Page of [TermsPage, PrivacyPage]) {
      const { unmount } = render(<Page />);
      expect(screen.getByRole("note").textContent).toMatch(/draft/i);
      expect(screen.getByRole("note").textContent).toMatch(/lawyer/i);
      unmount();
    }
  });

  it("have their own title and one main heading", () => {
    render(<TermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: /terms of use/i })).toBeTruthy();
    expect(String(termsMeta.title)).toMatch(/terms/i);
    cleanup();
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: /privacy policy/i })).toBeTruthy();
    expect(String(privacyMeta.title)).toMatch(/privacy/i);
  });

  it("the privacy draft states what is collected and what is not done, from what the product really does today", () => {
    const { container } = render(<PrivacyPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/email address/i);
    expect(text).toMatch(/sign-in link/i);
    expect(text).toMatch(/cookie/i);
    expect(text).toMatch(/do not record/i);
  });

  it("have no em dashes, and mark the details that still need the owner or a lawyer", () => {
    for (const Page of [TermsPage, PrivacyPage]) {
      const { container, unmount } = render(<Page />);
      expect(container.textContent).not.toMatch(/[—–]/);
      expect(container.textContent).toMatch(/\[to confirm[^\]]*\]/i);
      unmount();
    }
  });

  it("link back to the home page", () => {
    render(<TermsPage />);
    expect(screen.getByRole("link", { name: /workspace\.video/i }).getAttribute("href")).toBe("/");
  });
});
