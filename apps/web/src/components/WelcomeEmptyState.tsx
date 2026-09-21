import Link from "next/link";

/** What a signed-in person with no workspace sees: one clear action, and a line for
 *  the person who came in through an invite. */
export function WelcomeEmptyState() {
  return (
    <section className="space-y-4 py-8">
      <h2 className="text-lg font-semibold">Welcome.</h2>
      <p className="text-base text-neutral-300">You&apos;re not in a workspace yet.</p>
      <Link
        href="/workspaces/new"
        className="inline-flex min-h-12 items-center rounded bg-blue-600 px-4 text-base font-medium hover:bg-blue-500"
      >
        Create your workspace
      </Link>
      <p className="text-base text-neutral-300">Been invited? Open the invite link you were sent.</p>
    </section>
  );
}
