"use client";

// Shared card frame for the Security admin sections (policy / directory / SSO).
// Header (icon + title + desc + optional action) over a spinner/error/children body.
// Built on the shared console SectionCard so it carries the same radius, padding
// and uppercase micro-heading as every other Configurations surface.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";

export interface SecuritySectionProps {
  title: ReactNode;
  desc?: ReactNode;
  icon?: string;
  /** Header-right control (Save / Sync …); `false` renders nothing. */
  action?: ReactNode;
  loading?: boolean;
  /** Error text; replaces the body when set. */
  error?: ReactNode;
  /**
   * The on/off row. Rendered ABOVE the body and always visible, because it is the
   * one decision on the card that has to be readable without opening anything.
   */
  enable?: ReactNode;
  /**
   * The body is hidden when this is false. See the note below — a dozen inputs
   * for a feature that is switched off is the bulk of this screen.
   */
  expanded?: boolean;
  /** Shown in place of the body when collapsed: one line of current state. */
  summary?: ReactNode;
  /** "Show settings" / "Hide settings". */
  onToggleDetails?: () => void;
  children?: ReactNode;
}

/**
 * Shared card frame for the Security admin sections (policy / directory / SSO).
 *
 * PROGRESSIVE DISCLOSURE. Directory and SSO each carry a dozen inputs, a
 * collapsible attribute mapper and a role-map editor, and they were all rendered
 * unconditionally — on a tenant using neither, the screen was two long forms for
 * two features that are off. The switch and a one-line summary stay; the form
 * appears when the feature is turned ON, or when an admin asks to see it.
 *
 * Collapsing is NOT hiding state: `summary` says what is configured, so a
 * disabled-but-configured directory still reads as configured at a glance.
 */
export default function SecuritySection({
  title,
  desc,
  icon,
  action,
  loading,
  error,
  enable,
  expanded = true,
  summary,
  onToggleDetails,
  children,
}: SecuritySectionProps) {
  return (
    <SectionCard>
      <SectionHead icon={icon} title={title} desc={desc} action={action} />

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-nb-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base text-nb-blueb" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-[10px] border border-nb-crit/30 bg-nb-crit/10 px-3 py-3 text-sm text-nb-crit">{error}</div>
      ) : (
        <div className="space-y-3">
          {enable}

          {!expanded && (
            <div className="flex items-center gap-3 text-[12px] text-nb-muted">
              <span className="min-w-0 flex-1 truncate">{summary}</span>
              {onToggleDetails && (
                <button
                  type="button"
                  onClick={onToggleDetails}
                  className="shrink-0 text-[11.5px] text-nb-blueb transition hover:text-nb-ink"
                >
                  Show settings
                </button>
              )}
            </div>
          )}

          {expanded && (
            <>
              {children}
              {onToggleDetails && (
                <button
                  type="button"
                  onClick={onToggleDetails}
                  className="text-[11.5px] text-nb-muted transition hover:text-nb-ink"
                >
                  Hide settings
                </button>
              )}
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
