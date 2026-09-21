import { prisma } from "@workspace-video/db";
import { getSessionUser } from "@/lib/session";
import { env } from "@/lib/env";
import { SignInForm } from "@/components/SignInForm";
import { SignOutButton } from "@/components/SignOutButton";
import Link from "next/link";
import { WelcomeEmptyState } from "@/components/WelcomeEmptyState";
import { safeReturnPath } from "@/lib/returnPath";
import { describeLinkError } from "@/lib/auth/linkError";

/**
 * Landing page: sign-in with an emailed link (plus the dev sign-in when it is
 * enabled) and, once signed in, a list of the user's workspace rooms. Minimum UI
 * around the spatial room, which is the point, not this.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSessionUser();

  if (!session) {
    // `next` is where the person was going (an invited room); `error` is set when a
    // sign-in link they opened had expired or was already used.
    const params = await searchParams;
    const returnTo = safeReturnPath(params.next) ?? undefined;
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <SignInForm devAuth={env.devAuthEnabled} returnTo={returnTo} notice={describeLinkError(params.error)} />
      </main>
    );
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId },
    include: { workspace: { include: { rooms: true } } },
  });

  return (
    <main className="mx-auto max-w-xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="mb-1 text-xl font-semibold">workspace.video</h1>
          <p className="text-sm text-neutral-400">Signed in as {session.email}</p>
        </div>
        <div className="flex items-start gap-2">
          <Link
            href="/workspaces/new"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500"
          >
            Create workspace
          </Link>
          <SignOutButton />
        </div>
      </div>

      {memberships.length === 0 && <WelcomeEmptyState />}

      {memberships.map((m) => (
        <div key={m.workspace.id} className="mb-4 rounded-lg border border-neutral-800 p-4">
          <h2 className="mb-2 font-medium">{m.workspace.name}</h2>
          <ul className="space-y-1">
            {m.workspace.rooms.map((room) => (
              <li key={room.id}>
                <Link href={`/room/${room.id}`} className="text-sm text-blue-400 hover:underline">
                  {room.name} →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </main>
  );
}
