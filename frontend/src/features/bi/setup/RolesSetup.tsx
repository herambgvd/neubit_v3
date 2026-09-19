"use client";

// Building Intelligence → Setup → METRIC ROLES (gate 4): bind a point to the
// role a metric reads. Stranded roles — assertions left on a point that stopped
// reporting — are this task's worklist, one press away.
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";

import MetricRoles from "../MetricRoles";
import { bi } from "../api";
import { MODULE, PERM_READ } from "../constants";
import SetupHeader from "./SetupHeader";
import { STRANDED_HREF } from "./routes";

export default function RolesSetup() {
  const { can, hasModule } = useAuth();
  const mayRead = can(PERM_READ) && hasModule(MODULE);
  const orphansQ = useQuery<any>({
    queryKey: ["bi-role-orphans", ""],
    queryFn: () => bi.roleOrphans(),
    enabled: mayRead,
  });
  const stranded: number | null = orphansQ.data ? (orphansQ.data.orphans ?? []).length : null;

  if (!mayRead) {
    return (
      <div className="space-y-3">
        <SetupHeader task="roles" />
        <p className="text-[11.5px] text-nb-faint">
          Needs <span className="font-mono">bi.read</span> and the analytics module.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SetupHeader
        task="roles"
        desc="suggested from the tag · stored only when a person confirms"
        right={
          <Link
            href={STRANDED_HREF}
            title="Roles left on a point that stopped reporting — re-point or forget them"
            className="flex items-center gap-1 rounded-[7px] border border-nb-line px-2 py-0.5 text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
          >
            <span className="font-mono">{stranded ?? "—"}</span> stranded
            <Icon icon="heroicons-mini:arrow-right" className="text-[13px]" />
          </Link>
        }
      />
      <MetricRoles />
    </div>
  );
}
