import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Livento — Spend on memories, not impulses",
  description:
    "Livento finds concerts, shows, festivals and big experiences you'll love, shows the full cost, and helps you set money aside so impulse buys turn into memories.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23fffa8d'/%3E%3Cpath d='M15 9h12v37h23v10H15z'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
