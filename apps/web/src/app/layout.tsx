import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "workspace.video",
  description: "Spatial collaboration workspace — Milestone 1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
