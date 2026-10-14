import LandingClient from "@/components/LandingClient";
import ThemePin from "@/components/ThemePin";

export const metadata = {
  title: "Neubit — Unified Command & Control Platform",
  description:
    "The intelligence layer for enterprise command & control. Unify video, access, intrusion, fire, and analytics into a single operational platform.",
};

// The landing page is brand art in the console's navy, in every theme.
export default function Page() {
  return (
    <ThemePin>
      <LandingClient />
    </ThemePin>
  );
}
