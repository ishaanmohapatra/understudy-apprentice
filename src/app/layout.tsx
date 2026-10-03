import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Understudy",
  description: "Voice apprentice that learns the why behind expert screen work",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
