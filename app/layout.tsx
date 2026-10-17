import type { Metadata, Viewport } from "next";
import "./globals.css";

const NAME = process.env.ASSISTANT_NAME?.trim().toUpperCase() || "CAI";

export const metadata: Metadata = {
  title: NAME,
  description: `${NAME} — self-hosted AI assistant with memory and live web research`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#0a0a0b",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
