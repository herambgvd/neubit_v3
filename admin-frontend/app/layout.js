import "@/web/globals.css";
import "@/web/theme.css";

import { GeistSans } from "geist/font/sans";

import Providers from "@/web/Providers";

export const metadata = {
  title: "Neubit Admin",
  description: "Neubit — platform super-admin console",
};

// Dark-only console. Root font-size 14px keeps the UI compact (rem-based sizing).
export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark" style={{ fontSize: "14px" }} suppressHydrationWarning>
      <body className={`${GeistSans.className} antialiased bg-black text-foreground`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
