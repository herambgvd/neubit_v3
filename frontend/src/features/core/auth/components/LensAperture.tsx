"use client";

// THE LENS — the sign-in screen's one moving thing.
//
// The hero used to carry a headline, a paragraph of positioning and three stat
// chips, one of which claimed a percentage nobody on the screen can check. A
// sign-in page is not a brochure: it exists so somebody can get to work, and what
// it should say about the product is that the product is a camera system.
//
// So the copy goes and the lens stays, and the lens actually behaves like one:
//
//   * THE IRIS HUNTS. Not a sine wave — a real one steps: opens, overshoots,
//     settles. Three keyframes with a hold at the end read as a mechanism;
//     a smooth pulse reads as a screensaver.
//   * THE BLADES TURN, and it is the BROKEN ring that turns. An unbroken circle
//     rotating is invisible; six strokes at 60° are not.
//   * LIGHT CROSSES THE COATING every few seconds, an arc brightening as it goes
//     round — the thing you see on a real lens when a light source passes it.
//   * THE GLASS BREATHES: a soft radial fill behind the rings, drifting in
//     opacity, so the middle is not a hole.
//
// Framer-motion rather than CSS keyframes here because these are ORCHESTRATED —
// the iris and the blades share one timeline with per-key easings, which is the
// thing declarative keyframes are for and which hand-written CSS turns into four
// animations that drift apart. The home launcher keeps its CSS version: that one
// is left open on a wall for a shift, and the cheapest possible loop wins there.
import { motion, useReducedMotion } from "framer-motion";

export interface LensApertureProps {
  /** Viewport size in px — the SVG is square and scales to it. */
  size?: number;
  className?: string;
}

/** The six blades of the iris, at 60°. */
const BLADES = [
  "M0 -58 L32 -25",
  "M50 29 L18 50",
  "M-50 29 L-18 50",
  "M-50 -29 L-18 -50",
  "M50 -29 L18 -50",
  "M0 58 L-32 25",
];

export default function LensAperture({ size = 520, className = "" }: LensApertureProps) {
  // A page that respects this setting still shows the lens — it just stops it.
  // The aperture is part of the picture; the motion is what was asked about.
  const still = useReducedMotion();

  const hunt = still
    ? {}
    : {
        // open · overshoot · settle, then hold. The hold is what makes it a
        // mechanism that has finished moving rather than a thing that pulses.
        scale: [1, 1.06, 0.99, 1],
        transition: {
          duration: 7,
          times: [0, 0.28, 0.46, 1],
          ease: ["easeOut", "easeInOut", "easeOut", "linear"],
          repeat: Infinity,
          repeatDelay: 2.5,
        },
      };

  return (
    <svg
      aria-hidden="true"
      viewBox="-240 -240 480 480"
      width={size}
      height={size}
      className={className}
      fill="none"
    >
      <defs>
        <radialGradient id="nb-lens-glass" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity=".16" />
          <stop offset="55%" stopColor="#4c6ef5" stopOpacity=".06" />
          <stop offset="100%" stopColor="#0c1530" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="nb-lens-flare" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#67e8f9" stopOpacity="0" />
          <stop offset="50%" stopColor="#a5f3fc" stopOpacity=".9" />
          <stop offset="100%" stopColor="#67e8f9" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* THE GLASS. Without it the middle is a hole and the rings read as a
          target rather than as optics. */}
      <motion.circle
        r="168"
        fill="url(#nb-lens-glass)"
        animate={still ? {} : { opacity: [0.75, 1, 0.75] }}
        transition={still ? undefined : { duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* THE BARREL — two wide, quiet rings that do not move. Something has to
          stay still, or the whole drawing swims. */}
      <g stroke="#8fb0e8" opacity=".08">
        <circle r="196" strokeWidth="1" />
        <circle r="228" strokeWidth="1" />
      </g>

      {/* THE IRIS: rings and blades on ONE timeline, so they hunt together. */}
      <motion.g animate={hunt} style={{ originX: "0px", originY: "0px" }}>
        <g stroke="#22d3ee">
          <circle r="58" strokeWidth="1.6" opacity=".3" />
          <circle r="104" strokeWidth="1.2" opacity=".2" />
          <circle r="158" strokeWidth="1" opacity=".13" />
        </g>
        <motion.g
          stroke="#9fb9ec"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity=".42"
          animate={still ? {} : { rotate: 360 }}
          transition={still ? undefined : { duration: 72, repeat: Infinity, ease: "linear" }}
        >
          {BLADES.map((d) => (
            <path key={d} d={d} />
          ))}
        </motion.g>
      </motion.g>

      {/* THE FLARE. An arc of the outer ring, brightened, carried round — what a
          coated lens does when a light source passes it. */}
      {!still && (
        <motion.g
          animate={{ rotate: [0, 300], opacity: [0, 0.85, 0] }}
          transition={{
            duration: 4.5,
            times: [0, 0.35, 1],
            ease: "easeInOut",
            repeat: Infinity,
            repeatDelay: 5,
          }}
        >
          <path
            d="M 0 -158 A 158 158 0 0 1 112 -112"
            stroke="url(#nb-lens-flare)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path
            d="M 0 -104 A 104 104 0 0 1 74 -74"
            stroke="url(#nb-lens-flare)"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity=".7"
          />
        </motion.g>
      )}

      {/* The focus marks an operator would see on a barrel — still, and the only
          hard edges in the drawing. */}
      <g stroke="#67e8f9" opacity=".22" strokeWidth="1.4" strokeLinecap="round">
        <path d="M0 -228 L0 -212" />
        <path d="M228 0 L212 0" />
        <path d="M0 228 L0 212" />
        <path d="M-228 0 L-212 0" />
      </g>
    </svg>
  );
}
