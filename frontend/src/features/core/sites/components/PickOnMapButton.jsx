"use client";

// "Pick on map" — the offline counterpart to GeocodeButton. Shown in the site
// form whenever Google Maps is off, so an air-gapped operator can still set a
// site's coordinates without typing decimals by hand.
import { useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@iconify/react";

import { Button, Modal } from "@/components/ui/kit";
import { DEFAULT_TILES_URL } from "@/lib/map/config";
import { Loading } from "./MapChrome";

// Code-split: MapLibre GL should not ride along in the site-form chunk.
const OfflineMapPicker = dynamic(() => import("./OfflineMapPicker"), {
  ssr: false,
  loading: Loading,
});

// Roughly the whole world — the picker opens here when a site has no pin yet.
const WORLD_CENTER = { lat: 20, lng: 0 };
const WORLD_ZOOM = 1.4;

export default function PickOnMapButton({ tilesUrl = DEFAULT_TILES_URL, value, onResult }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);

  // Whatever is already in the form's lat/lng fields, but only when BOTH parse —
  // an empty string coerces to 0, and half a coordinate would open the picker in
  // the Gulf of Guinea rather than near the site.
  const parsed = (v) => (v === "" || v == null || !Number.isFinite(+v) ? null : +v);
  const lat = parsed(value?.latitude);
  const lng = parsed(value?.longitude);
  const existing = lat !== null && lng !== null ? { lat, lng } : null;

  const current = picked || existing;

  function openPicker() {
    setPicked(null);
    setOpen(true);
  }

  function confirm() {
    if (picked) onResult({ latitude: picked.lat, longitude: picked.lng });
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
        subtitle="Click the map to drop a pin. The coordinates fill into the form."
        size="wide"
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
          onChange={({ latitude, longitude }) => setPicked({ lat: latitude, lng: longitude })}
        />
      </Modal>
    </>
  );
}
