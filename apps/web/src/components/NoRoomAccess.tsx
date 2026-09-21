import Link from "next/link";
import { SignOutButton } from "./SignOutButton";

/** Shown to someone who is signed in but is not a member of the room they opened.
 *  It names the account they are using, because the usual cause is signing in with a
 *  different address than the one that was invited. It never says whether the room
 *  exists. */
export function NoRoomAccess({ email }: { email: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">You don&apos;t have access to this room</h1>
        <p className="text-base text-neutral-300">
          You&apos;re signed in as <span className="font-medium">{email}</span>. If you were invited with a different
          address, sign out and open the invite link again with that one.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SignOutButton />
          <Link
            href="/"
            className="inline-flex min-h-12 items-center rounded bg-blue-600 px-4 text-base font-medium hover:bg-blue-500"
          >
            Go to my workspaces
          </Link>
        </div>
      </div>
    </main>
  );
}
