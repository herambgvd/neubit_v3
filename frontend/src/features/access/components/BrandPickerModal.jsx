"use client";

// Onboard step 1 — pick the access-control brand. Ported from neubit_v2's
// brand-picker-modal.jsx; brands live in constants.js. Only DDS is available;
// others render greyed with a "Coming soon" pill. Uses the shared kit Modal.
import { Icon } from "@iconify/react";

import { Modal } from "@/components/ui/kit";
import { BRANDS } from "../constants";

export default function BrandPickerModal({ onClose, onPick }) {
  return (
    <Modal open onClose={onClose} title="Choose Access Control Brand" wide>
      <p className="mb-4 text-xs text-muted">
        Each access-control brand exposes a different API and integrates at a different depth. Pick the
        brand that matches the device you want to onboard.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {BRANDS.map((brand) => (
          <button
            key={brand.id}
            type="button"
            disabled={!brand.available}
            onClick={() => brand.available && onPick(brand.id)}
            className={`rounded-xl border bg-card p-4 text-left transition ${
              brand.available
                ? "cursor-pointer border-card-border hover:border-foreground"
                : "cursor-not-allowed border-card-border opacity-60"
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${brand.accent}`}>
                <Icon icon={brand.icon} className="text-lg" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-foreground">{brand.label}</h3>
                    {brand.subtitle && <p className="text-[11px] text-muted">{brand.subtitle}</p>}
                  </div>
                  {brand.available ? (
                    <Icon icon="heroicons-outline:chevron-right" className="shrink-0 text-base text-muted" />
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-hover px-2 py-0.5 text-[10px] font-medium text-muted">
                      <Icon icon="heroicons-outline:lock-closed" className="text-[10px]" />
                      Coming Soon
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">{brand.description}</p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
