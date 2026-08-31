import type { Metadata, Viewport } from "next";
import "./globals.css";
import Topbar from "@/components/Topbar";
import { THEME_SCRIPT } from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Scavenger Hunt",
  description: "Submit your evidence.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Zoom stays enabled deliberately: someone will need to squint at a task in
  // bright sun, and locking zoom to look tidy is a bad trade.
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1216" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies a saved theme before first paint. Without this, a phone set
            to dark mode flashes white on every navigation. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Topbar />
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
