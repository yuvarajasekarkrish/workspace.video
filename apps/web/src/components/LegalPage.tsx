import Link from "next/link";

/** The shared frame for the plain pages behind the footer links (changelog, terms, privacy). */
export function PageFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ground text-fg">
      <header className="mx-auto max-w-3xl px-4 pt-8">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-base font-semibold tracking-tight">
          <span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-accent">
            <span className="size-2.5 rounded-full bg-on-accent" />
          </span>
          workspace.video
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10">
        <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** Says, at the top of a legal page, that the text is a draft. Shown until a lawyer has reviewed it. */
export function DraftNotice() {
  return (
    <aside role="note" className="mt-6 rounded-xl border border-line bg-surface px-4 py-3 text-base text-fg">
      Draft. This page is written in plain language by the product team and has not been reviewed by a lawyer. Parts in
      square brackets are still to be decided. It will change before real users sign up.
    </aside>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-2xl font-semibold tracking-tight">{heading}</h2>
      <div className="mt-3 space-y-3 text-lg leading-relaxed text-fg-muted">{children}</div>
    </section>
  );
}
