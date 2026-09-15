import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { CreateWorkspaceForm } from "@/components/CreateWorkspaceForm";

export default async function NewWorkspacePage() {
  const session = await getSessionUser();
  if (!session) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <CreateWorkspaceForm />
    </main>
  );
}
