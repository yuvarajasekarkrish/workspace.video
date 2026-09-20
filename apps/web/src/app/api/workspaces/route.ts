import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@workspace-video/db";
import { PlanIdSchema, DEFAULT_LAYOUT_ID } from "@workspace-video/shared";
import { getSessionUser } from "@/lib/session";

// Not a full zod object schema here — apps/web has no direct zod dependency
// (it only ever reaches zod indirectly through @workspace-video/shared/@workspace-video/db);
// PlanIdSchema (already exported from @workspace-video/shared) validates `plan`, and
// `name` gets the same manual check style dev-signin/route.ts already uses.
function parseBody(body: unknown): { name: string; plan: import("@workspace-video/shared").PlanId } | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, plan } = body as { name?: unknown; plan?: unknown };
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) return null;
  const parsedPlan = PlanIdSchema.safeParse(plan);
  if (!parsedPlan.success) return null;
  return { name: trimmed, plan: parsedPlan.data };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "workspace"}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates a workspace, its creator's owner membership, and one office room —
 * all in a single transaction so a failure partway through never leaves a
 * workspace with no owner or no room. Every plan gets the identical
 * `openOffice@1` layout (see the plan's central decision: the floor and the
 * subscription's participant limit are independent concerns) — `plan` only
 * ever affects PLAN_PARTICIPANT_LIMITS lookups at join time, never which
 * layout a room renders.
 *
 * No payment/billing exists yet — any signed-in user may pick any plan (see
 * the approved plan's R6). This is the seam a future billing system plugs
 * into without changing anything downstream of Workspace.plan.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = parseBody(body);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid workspace name or plan." }, { status: 400 });
  }
  const { name, plan } = parsed;

  const result = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name, slug: slugify(name), plan },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: session.userId, role: "owner" },
    });
    const room = await tx.room.create({
      data: {
        workspaceId: workspace.id,
        name: "Main Office",
        config: { layoutId: DEFAULT_LAYOUT_ID },
      },
    });
    return { workspaceId: workspace.id, roomId: room.id };
  });

  return NextResponse.json({ ok: true, ...result });
}
