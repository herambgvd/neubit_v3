"use client";

// THE ONE PLACE A REASON IS RENDERED, and the answer to the complaint that
// finally landed on this console: every screen explained itself at length.
//
// Nothing about the HONESTY rules changed and nothing here relaxes them. A
// blocked number still prints what is blocking it rather than a bare zero, an
// absent figure still carries the sentence that says why, and no reason
// disappears. What changed is the DELIVERY: the sentence that qualifies a number
// is a LABEL on screen and a paragraph one press away, instead of a paragraph on
// screen every morning forever.
//
// The split is the FIRST SENTENCE, because these reasons were written the same
// way everywhere in this codebase — the fact and its number first, the argument
// for why it is stated that way after it. So the lead is what a reader has to
// see and the tail is what they need once. Both stay in the product:
//
//   visible   the lead sentence, always, never truncated mid-word and never
//             replaced by an icon or a colour.
//   hover     the WHOLE reason, on the `title` of the paragraph, so a mouse
//             reaches it with no press at all.
//   press     "why" expands the tail in place. It closes again, it is a button
//             rather than a route, and nothing about the page moves under it.
//
// A reason with ONE sentence renders as itself with no control beside it: a
// "why" that expands nothing is the decorative control this console bans.
//
// WHERE THIS MUST NOT BE USED. A sentence whose whole job is to be read BEFORE
// an irreversible press — the forget confirmation on Stranded Roles, which names
// the assertion it deletes — is not a qualification of a number and does not go
// behind a press. That one is still printed in full, deliberately.
import { useId, useState } from "react";

/** Split a reason into the sentence that must be seen and the argument behind
 *  it. The tail is everything after the first terminator followed by a space.
 *
 *  An em-dash clause, a decimal, a `kWh/m²/yr` and an abbreviation like "e.g."
 *  are all common in these strings, so the split is on `. ` / `? ` / `! ` only
 *  and never on a bare dot — `0.4 degC` must not become two sentences. */
export function splitReason(text: string): readonly [string, string] {
  const s = (text ?? "").trim();
  const m = /[.?!] /.exec(s);
  if (!m) return [s, ""] as const;
  const cut = m.index + 1;
  return [s.slice(0, cut), s.slice(cut).trim()] as const;
}

export interface ReasonProps {
  /** The whole reason, exactly as the model or the server wrote it. */
  text?: string | null;
  /** Tone class for the paragraph. The default is this console's faint body. */
  className?: string;
  /** What the control says when there is a tail. */
  moreLabel?: string;
}

export default function Reason({
  text,
  className = "text-[10.5px] leading-relaxed text-nb-faint",
  moreLabel = "why",
}: Readonly<ReasonProps>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [lead, tail] = splitReason(text ?? "");
  if (!lead) return null;

  if (!tail) {
    return <p className={className}>{lead}</p>;
  }

  return (
    <p className={className} title={`${lead} ${tail}`}>
      {lead}{" "}
      {open && <span id={id}>{tail} </span>}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="rounded-[5px] border border-nb-line px-1 py-px text-[9.5px] uppercase tracking-[.8px] text-nb-muted transition hover:border-nb-blue/60 hover:text-nb-blueb"
      >
        {open ? "less" : moreLabel}
      </button>
    </p>
  );
}
