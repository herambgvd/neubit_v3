"use client";

// "Fetch from address" for the site form — turns the typed street / city / state /
// zip / country into latitude & longitude using the Google Maps Geocoder. Only
// rendered when the tenant has Google Maps enabled AND a key saved (GET
// /settings/maps), so the Maps JS API is never loaded for tenants that don't use
// it. The lookup runs in the browser through the JS API rather than server-side
// against the REST endpoint because the saved key is HTTP-referrer restricted.
import { useState } from "react";
import { useJsApiLoader } from "@react-google-maps/api";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

// Google's geocoder statuses, translated into something an operator can act on.
const STATUS_MESSAGE = {
  ZERO_RESULTS: "No place matched that address — add more detail and try again.",
  REQUEST_DENIED:
    "This Maps key may not geocode. Enable the Geocoding API for it in Google Cloud Console.",
  OVER_QUERY_LIMIT: "Google's geocoding quota for this key is exhausted.",
  INVALID_REQUEST: "The address is incomplete.",
  UNKNOWN_ERROR: "Google could not be reached — try again.",
};

// [form field, human label] — all of them must be filled before the lookup runs.
const ADDRESS_PARTS = [
  ["street", "street"],
  ["city", "city"],
  ["state", "state / region"],
  ["zipCode", "zip code"],
  ["country", "country"],
];

export default function GeocodeButton({ apiKey, address, onResult }: any) {
  // Same loader id as the Sites Map so the script is shared, never injected twice.
  const { isLoaded, loadError } = useJsApiLoader({ googleMapsApiKey: apiKey, id: "neubit-google-map" });
  const [busy, setBusy] = useState(false);

  // Every address line is required before we ask Google — a partial address
  // geocodes to the middle of a city (or the wrong one) and quietly writes a
  // plausible-looking pin nobody notices is wrong.
  const missing = ADDRESS_PARTS.filter(([key]) => !(address[key] || "").trim()).map(([, label]) => label);
  const query = ADDRESS_PARTS.map(([key]) => (address[key] || "").trim()).join(", ");

  async function run() {
    if (missing.length) return;
    setBusy(true);
    try {
      // Callback form — supported by every JS API release, unlike the newer promise one.
      const results = await new Promise((resolve, reject) => {
        new window.google.maps.Geocoder().geocode({ address: query }, (res, status) => {
          if (status === "OK" && res?.length) resolve(res);
          else reject(new Error(status || "UNKNOWN_ERROR"));
        });
      });
      const best = results[0];
      onResult({
        latitude: best.geometry.location.lat(),
        longitude: best.geometry.location.lng(),
        formatted: best.formatted_address,
      });
      toast.success("Coordinates filled from the address");
    } catch (e) {
      toast.error(STATUS_MESSAGE[e.message] || `Could not fetch coordinates (${e.message})`);
    } finally {
      setBusy(false);
    }
  }

  const disabled = missing.length > 0 || !isLoaded || busy || !!loadError;
  const title = loadError
    ? "Google Maps failed to load — check the API key"
    : missing.length
      ? `Fill in the ${missing.join(", ")} above first`
      : !isLoaded
        ? "Loading Google Maps…"
        : "Look this address up on Google Maps";

  return (
    <button
      type="button"
      onClick={run}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-[9px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] px-3 py-1.5 text-[11.5px] tracking-[.3px] text-nb-blueb transition hover:bg-[rgba(96,165,250,.18)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon icon={busy ? "svg-spinners:180-ring" : "heroicons-outline:map-pin"} className="text-sm" />
      {busy ? "Fetching…" : "Fetch from address"}
    </button>
  );
}
