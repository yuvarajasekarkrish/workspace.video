import { getAuth, emailLimiter } from "@/lib/auth";
import { handleAuthRequest } from "@/lib/auth/handleAuthRequest";
import { env } from "@/lib/env";

/**
 * Sign-in with an emailed one-time link (Better Auth), for every path under
 * /api/auth that has no route of its own. The fixed routes next to this file
 * (dev-signin, session, realtime-token) take precedence over it.
 */
const handle = (request: Request) => handleAuthRequest(getAuth(), request, { emailLimiter, baseURL: env.appUrl });

export { handle as GET, handle as POST };
