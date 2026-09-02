import { redirect } from "next/navigation";

// Recordings tab was FOLDED into Playback (calendar + colored timeline covers estate
// browse + clip extract; evidence-lock lives in Playback's focus player). Keep this
// route as a redirect so old bookmarks / deep-links land on the replacement surface.
export default function RecordingsRedirect() {
  redirect("/playback");
}
