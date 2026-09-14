import { prisma } from "@cosmos/db";
import { getSessionUser } from "@/lib/session";
import { SignInForm } from "@/components/SignInForm";
import Link from "next/link";

/**
 * Landing page: dev sign-in (see api/auth/dev-signin) plus a list of the
 * signed-in user's workspace rooms. Minimum UI to drive Milestone 1's
 * two-browser verification — the spatial room itself is the point, not this.
 */
export default async function HomePage() {
  const session = await getSessionUser();

  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <SignInForm />
      </main>
    );
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId },
    include: { workspace: { include: { rooms: true } } },
  });

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="mb-1 text-xl font-semibold">Cosmos Workspace</h1>
      <p className="mb-6 text-sm text-neutral-400">Signed in as {session.email}</p>

      {memberships.length === 0 && (
        <p className="text-sm text-neutral-500">No workspaces yet — run the db seed script.</p>
      )}

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
