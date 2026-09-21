import type { Metadata } from "next";
import { PageFrame } from "@/components/LegalPage";
import { CHANGELOG } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog | workspace.video",
  description: "What has shipped in workspace.video, newest first.",
};

export default function ChangelogPage() {
  return (
    <PageFrame title="Changelog">
      <p className="mt-4 text-lg leading-relaxed text-fg-muted">What has shipped, newest first.</p>
      <div className="mt-10 divide-y divide-line border-y border-line">
        {CHANGELOG.map((entry) => (
          <article key={entry.date + entry.title} className="py-8">
            <time dateTime={entry.date} className="tabular text-base text-fg-muted">
              {entry.date}
            </time>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight">{entry.title}</h2>
            <p className="mt-3 text-lg leading-relaxed text-fg-muted">{entry.body}</p>
          </article>
        ))}
      </div>
    </PageFrame>
  );
}
