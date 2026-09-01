import { redirect } from "next/navigation";

// API Keys now live inside the Security console as its "API Keys" segment.
export default function ApiKeysRedirect() {
  redirect("/config/security?view=keys");
}
