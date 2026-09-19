"use client";

// The header every Setup page wears: Setup › the task, and the task's gate.
import type { ReactNode } from "react";

import { EstateHeader } from "@/components/console";

import { SETUP_HREF, SETUP_TASKS, type SetupTaskId } from "./routes";

export interface SetupHeaderProps {
  task: SetupTaskId;
  /** A second crumb under the task (Stranded roles under Metric roles). */
  sub?: string;
  desc?: ReactNode;
  /** The page's own action, beside the gate number. */
  right?: ReactNode;
}

export default function SetupHeader({ task, sub, desc, right }: Readonly<SetupHeaderProps>) {
  const t = SETUP_TASKS.find((x) => x.id === task)!;
  const crumbs = [
    { label: "Setup", href: SETUP_HREF },
    sub ? { label: t.label, href: t.href } : { label: t.label },
    ...(sub ? [{ label: sub }] : []),
  ];
  return (
    <EstateHeader
      crumbs={crumbs}
      desc={desc}
      right={
        <>
          {right}
          {t.gate && <span className="font-mono">gate {t.gate}</span>}
        </>
      }
    />
  );
}
