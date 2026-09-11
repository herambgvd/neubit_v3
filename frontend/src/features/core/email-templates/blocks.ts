// The visual email designer's document model.
//
// WHY BLOCKS AT ALL: the stored template is Jinja-in-HTML, and an operator cannot
// be asked to write either. Blocks give them headings, paragraphs, buttons and
// images; this module turns those into the HTML the sender renders.
//
// ROUND-TRIPPING IS THE HARD PART, and it is solved by NOT parsing. HTML→blocks
// for arbitrary markup is lossy — a template hand-edited in the HTML tab, or one
// of the built-in defaults with its `{% if %}` branches, has no faithful block
// form. So the block list is serialised into a comment at the top of the HTML and
// read back verbatim. If that marker is absent the document was not made here,
// and the designer says so rather than mangling it into blocks it can render.
//
// The generated HTML is inline-styled and table-free on purpose: it is wrapped by
// `wrap_email` (messaging/templates.py) which supplies the shell, and email
// clients ignore <style> blocks.

import { randomId } from "@/lib/random";

export type BlockType = "heading" | "text" | "button" | "image" | "divider" | "spacer";

export interface Block {
  id: string;
  type: BlockType;
  /** heading/text/button: the words. image: the alt text. */
  text?: string;
  /** button/image: where it points / what it shows. */
  url?: string;
  /** heading only. */
  level?: 2 | 3;
  /** text/heading: left | center. */
  align?: "left" | "center";
}

export const BLOCK_LABELS: Record<BlockType, { label: string; icon: string }> = {
  // `heroicons:h1`, not `heroicons-outline:h1`. The v1 set has no such name, so
  // the outline prefix renders as blank space — the same trap that had thirteen
  // icons invisible in this console. `icons.test.ts` caught this one.
  heading: { label: "Heading", icon: "heroicons:h1" },
  text: { label: "Paragraph", icon: "heroicons-outline:bars-3-bottom-left" },
  button: { label: "Button", icon: "heroicons-outline:cursor-arrow-rays" },
  image: { label: "Image", icon: "heroicons-outline:photo" },
  divider: { label: "Divider", icon: "heroicons-outline:minus" },
  spacer: { label: "Spacer", icon: "heroicons-outline:arrows-up-down" },
};

/** The marker that says "this HTML was produced here, and here is its source". */
const MARKER = "nb-blocks:";

export function newBlock(type: BlockType): Block {
  const id = `b${randomId(12)}`;
  switch (type) {
    case "heading":
      return { id, type, text: "Heading", level: 2, align: "left" };
    case "text":
      return { id, type, text: "Write something here.", align: "left" };
    case "button":
      return { id, type, text: "Open", url: "{{ login_url }}" };
    case "image":
      return { id, type, text: "", url: "" };
    default:
      return { id, type };
  }
}

/**
 * HTML-escape, EXCEPT Jinja delimiters.
 *
 * An operator types `{{ title }}` into a field; escaping it would ship
 * `&#123;&#123;` and the placeholder would never substitute. So `<`, `>` and `&`
 * are escaped — that is the injection that matters, since this HTML is rendered
 * in a mail client — while `{`/`}` are left alone.
 */
export function escapeText(value: string): string {
  return (value || "").replaceAll(/&/g, "&amp;").replaceAll(/</g, "&lt;").replaceAll(/>/g, "&gt;");
}

/** A URL fit for an href/src. Rejects anything that is not http(s) or a placeholder. */
export function safeUrl(value: string): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  // A pure Jinja expression is substituted server-side and cannot be judged here.
  if (/^\{\{[^}]+\}\}$/.test(raw)) return raw;
  return /^https?:\/\//i.test(raw) ? escapeText(raw) : "";
}

function renderBlock(b: Block): string {
  const align = b.align === "center" ? "text-align:center;" : "";
  switch (b.type) {
    case "heading": {
      const size = b.level === 3 ? "18px" : "22px";
      return `<h${b.level || 2} style="margin:0 0 12px;font-size:${size};${align}">${escapeText(b.text || "")}</h${b.level || 2}>`;
    }
    case "text":
      return `<p style="margin:0 0 12px;${align}">${escapeText(b.text || "").replaceAll(/\n/g, "<br>")}</p>`;
    case "button": {
      const href = safeUrl(b.url || "");
      if (!href) return "";
      return (
        `<p style="margin:20px 0"><a href="${href}" ` +
        `style="display:inline-block;background:#111;color:#fff;text-decoration:none;` +
        `padding:11px 20px;border-radius:8px;font-weight:600">${escapeText(b.text || "Open")}</a></p>`
      );
    }
    case "image": {
      const src = safeUrl(b.url || "");
      if (!src) return "";
      return `<p style="margin:0 0 12px"><img src="${src}" alt="${escapeText(b.text || "")}" style="max-width:100%;border-radius:8px"></p>`;
    }
    case "divider":
      return `<hr style="border:0;border-top:1px solid #eaeaea;margin:20px 0">`;
    case "spacer":
      return `<div style="height:20px"></div>`;
    default:
      return "";
  }
}

/** Blocks → the HTML that is stored and sent, with the source embedded. */
export function blocksToHtml(blocks: Block[]): string {
  const body = blocks.map(renderBlock).join("");
  // The source travels in a comment so the designer can reopen its own work
  // exactly. Comments are stripped by every mail client and cost a few bytes.
  return `<!--${MARKER}${JSON.stringify(blocks)}-->${body}`;
}

/**
 * The blocks that produced this HTML, or null when it was not produced here.
 *
 * Null is the honest answer for a hand-written template or a built-in default:
 * showing an approximation of someone else's markup as editable blocks would lose
 * whatever it could not represent the moment they pressed save.
 */
export function htmlToBlocks(html: string): Block[] | null {
  const match = (html || "").match(/^<!--nb-blocks:([\s\S]*?)-->/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;
    // Only well-formed entries: a malformed one would render as an empty block
    // the operator cannot see or remove.
    //
    // An EMPTY result is still a design, not a refusal. The marker is the signal;
    // returning null for `[]` sent "Start a design" straight back to the
    // not-built-here screen the moment it was saved.
    return parsed.filter(
      (b): b is Block =>
        !!b && typeof b === "object" && typeof (b as Block).id === "string" && (b as Block).type in BLOCK_LABELS,
    );
  } catch {
    return null;
  }
}
