"use client";

// "Pick on map" — the offline counterpart to GeocodeButton. Shown in the site
// form whenever Google Maps is off, so an air-gapped operator can still set a
// site's coordinates without typing decimals by hand.
import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@iconify/react";

import { Button, Modal, Spinner } from "@/components/ui/kit";
import { DEFAULT_TILES_URL } from "@/lib/map/config";
import { reverseGeocode, type ResolvedAddress } from "@/lib/map/geocoder";
import { Loading } from "./MapChrome";

// Code-split: MapLibre GL should not ride along in the site-form chunk.
const OfflineMapPicker = dynamic(() => import("./OfflineMapPicker"), {
  ssr: false,
  loading: Loading,
});

// Roughly the whole world — the picker opens here when a site has no pin yet.
const WORLD_CENTER = { lat: 20, lng: 0 };
const WORLD_ZOOM = 1.4;

/** A point as the form fields hold it — raw text, or the hydrated number. */
export interface PickOnMapValue {
  latitude: string | number;
  longitude: string | number;
}

export interface PickOnMapButtonProps {
  tilesUrl?: string;
  value: PickOnMapValue;
  /**
   * `address` is what the geocoder says is AT the pin, or null when it says
   * nothing (no service installed, or a pin in the middle of a field). The
   * coordinates are always present — a point nobody can name is still a valid
   * site location, so a failed lookup must never block the pick.
   */
  onResult: (result: {
    latitude: number;
    longitude: number;
    address: ResolvedAddress | null;
  }) => void;
}

export default function PickOnMapButton({ tilesUrl = DEFAULT_TILES_URL, value, onResult }: PickOnMapButtonProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null);
  const [address, setAddress] = useState<ResolvedAddress | null>(null);
  const [resolving, setResolving] = useState(false);
  // Same generation counter as PlaceSearch, for the same reason: the operator can
  // move the pin faster than the lookup answers, and the OLD answer must not win.
  const lookup = useRef(0);

  // Whatever is already in the form's lat/lng fields, but only when BOTH parse —
  // an empty string coerces to 0, and half a coordinate would open the picker in
  // the Gulf of Guinea rather than near the site.
  const parsed = (v: string | number | null | undefined) =>
    v === "" || v == null || !Number.isFinite(+v) ? null : +v;
  const lat = parsed(value?.latitude);
  const lng = parsed(value?.longitude);
  const existing = lat !== null && lng !== null ? { lat, lng } : null;

  const current = picked || existing;

  function openPicker() {
    setPicked(null);
    setAddress(null);
    setOpen(true);
  }

  // Resolved as soon as the pin lands, not when "Use this point" is clicked, so
  // the operator can SEE what they picked before committing to it — and so the
  // confirm stays instant.
  function pinDropped(lat: number, lng: number) {
    setPicked({ lat, lng });
    setAddress(null);
    const mine = ++lookup.current;
    setResolving(true);
    reverseGeocode(lat, lng)
      .then((found) => {
        if (mine !== lookup.current) return;
        setAddress(found);
      })
      .finally(() => {
        if (mine === lookup.current) setResolving(false);
      });
  }

  function confirm() {
    if (picked) onResult({ latitude: picked.lat, longitude: picked.lng, address });
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={openPicker}
        title="Drop a pin on the offline map to set this site's coordinates"
        className="inline-flex items-center gap-1.5 rounded-[9px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] px-3 py-1.5 text-[11.5px] tracking-[.3px] text-nb-blueb transition hover:bg-[rgba(96,165,250,.18)]"
      >
        <Icon icon="heroicons-outline:map-pin" className="text-sm" />
        Pick on map
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Pick the site location"
        subtitle="Search for a place or paste coordinates, then click the map to drop the pin."
        size="full"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={!picked}>
              Use this point
            </Button>
          </>
        }
      >
        <OfflineMapPicker
          tilesUrl={tilesUrl}
          center={existing || WORLD_CENTER}
          zoom={WORLD_ZOOM}
          value={current}
          onChange={({ latitude, longitude }) => pinDropped(latitude, longitude)}
        />
        {picked && (
          <p className="mt-3 flex items-center gap-2 text-[11.5px] text-nb-muted">
            {resolving ? (
              <>
                <Spinner className="!h-3 !w-3" /> Looking up what is here…
              </>
            ) : address ? (
              <>
                <Icon icon="heroicons-outline:map-pin" className="text-sm text-nb-blueb" />
                <span className="text-nb-ink">{address.label}</span>
                <span>— this fills the address fields</span>
              </>
            ) : (
              // Not a failure worth an amber warning: plenty of real sites sit
              // where OpenStreetMap has nothing to name.
              <>Nothing mapped at this point — the coordinates are still used.</>
            )}
          </p>
        )}
      </Modal>
    </>
  );
}
