import type { Metadata } from "next";

/** The browser tab title and the preview shown when the link is shared. */
const TITLE = "workspace.video: a virtual office you walk around in";
const DESCRIPTION = "A virtual office you walk around in. Remote teams that feel like a team.";

export const siteMetadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "workspace.video",
    type: "website",
  },
};
