"use client";

// The DashForge embed VIEWER: one registered dashboard, rendered in an iframe
// against a token this browser was handed only after NeuBit checked the caller.
//
// WHY AN IFRAME AND NOT A NATIVE RENDERER. DashForge owns what a dashboard means
// — its layout, its widget types, its query semantics, its filter bar. Drawing
// it here would be a second implementation of somebody else's product, and the
// first symptom of drift is a chart that renders differently in the two places
// with no way to say which one is right. The iframe is also what keeps
// DashForge's own CSP `frame-ancestors` policy meaningful: the framing decision
// is made by the browser against the peer's header, not by anything in here.
//
// THE TOKEN NEVER OUTLIVES THE VIEW. `session()` mints one on mount and the
// timer below re-mints shortly before the server-declared expiry, so the URL in
// this iframe is a credential with a bounded life rather than a stored secret.
// The lifetime is the SERVER's (see backend/core/app/dashforge/client.py);
// this component only reads `expires_at` and schedules against it. Deliberately
// NOT done: caching a session in React Query or localStorage. A bearer
// credential that survives the component that needed it is the leak the
// per-session mint exists to close, and localStorage would additionally hand it
// to every other tab on this origin.
//
// A re-mint swaps the iframe `src`, which reloads the embed page. That is a
// visible flicker once every TTL, and it is the right trade against the
// alternative — a silently dead token that renders DashForge's "link expired"
// state to an operator who did nothing wrong.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { EmptyPane, LoadingBlock } from "@/components/console";
import { apiError } from "@/lib/api";

import { dashforge, type DashForgeSession } from "./api";
import { REMINT_MARGIN_MS, REMINT_MIN_MS } from "./constants";

export default function EmbedView({ id, name }: { id: string; name?: string }) {
  const [session, setSession] = useState<DashForgeSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to force a re-mint. A counter rather than a boolean so a second
  // request while one is in flight still lands.
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // `alive` guards the two ways this effect's answer can arrive too late: the
    // operator switched dashboards, or the page unmounted. Writing a token for
    // dashboard A into the state of dashboard B would frame the wrong data.
    let alive = true;
    setError(null);
    dashforge
      .session(id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        const at = Date.parse(s.expires_at);
        if (!Number.isFinite(at)) return;
        const delay = Math.max(at - Date.now() - REMINT_MARGIN_MS, REMINT_MIN_MS);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setNonce((n) => n + 1), delay);
      })
      .catch((e) => {
        if (!alive) return;
        setSession(null);
        setError(apiError(e, "Could not open this dashboard"));
      });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, nonce]);

  const locked = useMemo(() => Object.entries(session?.scope ?? {}), [session]);

  if (error) {
    return (
      <EmptyPane
        icon="heroicons:exclamation-triangle"
        title="This dashboard did not open"
        // The peer's own refusal text, verbatim. DashForge names the widget or
        // the filter key it objected to, which is information this console
        // cannot reconstruct and must not flatten into "something went wrong".
        subtitle={error}
      />
    );
  }

  if (!session) return <LoadingBlock label={`Opening ${name || "dashboard"}…`} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {locked.length > 0 && (
        // Shown because an operator looking at filtered numbers deserves to know
        // they are filtered and cannot change it. This reveals nothing: the
        // bindings are already readable inside the token, whose payload is
        // base64, not encrypted.
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5 text-[11px] text-nb-faint">
          <Icon icon="heroicons:lock-closed" className="h-3 w-3" />
          <span className="uppercase tracking-[1.1px]">locked to</span>
          {locked.map(([k, v]) => (
            <span
              key={k}
              className="rounded-[6px] border border-nb-line px-1.5 py-0.5 font-mono text-[10.5px] text-nb-ink"
            >
              {k}={v}
            </span>
          ))}
        </div>
      )}
      <iframe
        // Keyed on the token so a re-mint remounts the frame rather than relying
        // on the browser to re-navigate an iframe whose src attribute changed.
        key={session.token}
        src={session.iframe_url}
        title={name || "DashForge dashboard"}
        className="min-h-0 w-full flex-1 rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.7)]"
        // No allow-same-origin: the embed page is on the DashForge origin and
        // has no business reaching this one. Scripts and forms are what the
        // dashboard itself needs to run.
        sandbox="allow-scripts allow-forms allow-popups"
        // The token is in the URL. Sending it on as a Referer to anything the
        // embed page loads would hand the credential to a third origin for free.
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
