import type { Metadata } from "next";
import "./globals.css";
import { siteMetadata } from "@/lib/siteMetadata";

export const metadata: Metadata = siteMetadata;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
