import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Video lab",
  description: "CPU-based video processing with an ordered filter pipeline.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
