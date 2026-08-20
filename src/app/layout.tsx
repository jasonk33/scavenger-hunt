import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import Notice from "@/components/Notice";

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
  themeColor: "#f6f7f9",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <Notice />
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
