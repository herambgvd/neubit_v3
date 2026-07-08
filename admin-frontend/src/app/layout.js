import "@/styles/globals.css";
import "@/styles/theme.css";

import { GeistSans } from "geist/font/sans";

import Providers from "@/components/Providers";

export const metadata = {
  title: "Neubit Admin",
  description: "Neubit — platform super-admin console",
};

// Set the theme class before first paint to avoid a flash (reads localStorage).
// Defaults to dark when nothing is saved.
const noFlashScript = `
try {
  var t = localStorage.getItem('theme');
  document.documentElement.classList.toggle('dark', t !== 'light');
} catch (e) { document.documentElement.classList.add('dark'); }
`;

// Root font-size 14px keeps the UI compact (rem-based sizing).
export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark" style={{ fontSize: "14px" }} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body className={`${GeistSans.className} antialiased bg-background text-foreground`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
