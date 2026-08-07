import { redirect } from "next/navigation";

// The VMS-side 3rd-party-NVR onboarding surface is RETIRED. Single-ownership: the
// standalone recorder owns all cameras (direct + 3rd-party NVRs onboarded on the
// recorder edge), so the VMS no longer onboards NVRs — it federates recorder NODES.
// Keep this route as a redirect so old bookmarks / deep-links land on Recorders.
export default function NvrRedirect() {
  redirect("/devices/recorders");
}
