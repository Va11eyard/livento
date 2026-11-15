import type { Metadata, Viewport } from "next";
import { THEME_COLOR, THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

// Absolute base for Open Graph / Twitter image URLs. On Vercel, the production
// domain is provided at build time; NEXT_PUBLIC_SITE_URL overrides it (custom domain).
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const title = "Livento — Spend on memories, not impulses";
const description =
  "Livento finds concerts, shows, festivals and big experiences you'll love, shows the full cost, and saves for them automatically in your Livento wallet.";

// Icons come from the app/ file conventions: favicon.ico, icon.svg, apple-icon.png.
// Share images come from app/opengraph-image.png and app/twitter-image.png.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "Livento",
  openGraph: {
    type: "website",
    siteName: "Livento",
    title,
    description,
    url: "/",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

// Browser bar per system scheme; an explicit light/night choice overrides it (lib/theme.ts).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The inline script sets data-theme on <html> before the first paint (a saved light/night
    // choice), so React must accept that attribute on hydration.
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
