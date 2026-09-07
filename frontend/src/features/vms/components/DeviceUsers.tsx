"use client";

// DeviceUsers — ONVIF device account management (GetUsers / CreateUsers / DeleteUsers)
// for the camera Maintenance tab. Lists the device's accounts + lets an admin add or
// remove one. Best-effort per device — surfaces "not supported" gracefully.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { DeviceUserPublic, FleetOpPublic, UserAddBody } from "../types";

const LEVELS = ["Administrator", "Operator", "User"];

/** What `GET /cameras/{id}/users` actually returns — the FleetOpPublic envelope
 *  (backend/vision/app/vms/devicemgmt/router.py `response_model=FleetOpPublic`)
 *  with the driver's account rows under `data.users`. types.ts' DeviceUsersResponse
 *  (an ItemList / bare list) does not match the router, so the read is narrowed here. */
interface DeviceUsersFleetOp extends Omit<FleetOpPublic, "data"> {
  data?: { users?: DeviceUserPublic[] };
}

// The row's account name — the ONVIF driver sends `username`; keep the aliases the
// wire type allows for other drivers.
const nameOf = (u: DeviceUserPublic) => u.username ?? u.user ?? u.name ?? "";

export interface DeviceUsersProps {
  cameraId: string;
}

export default function DeviceUsers({ cameraId }: DeviceUsersProps) {
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const qc = useQueryClient();

  const usersQ = useQuery({
    queryKey: ["vms-device-users", cameraId],
    // The declared wire type is wrong for this route (see DeviceUsersFleetOp).
    queryFn: async () => (await vms.deviceMgmt.users(cameraId)) as unknown as DeviceUsersFleetOp,
    enabled: !!cameraId && can("vms.camera.read"),
    retry: false,
    staleTime: 30_000,
  });
  const res: Partial<DeviceUsersFleetOp> = usersQ.data || {};
  const users = res.data?.users || [];
  const unsupported = res.supported === false;

  const [form, setForm] = useState<Required<UserAddBody>>({ user: "", password: "", level: "User" });

  const add = useMutation({
    mutationFn: () => vms.deviceMgmt.addUser(cameraId, form),
    onSuccess: (r) => {
      if (r?.ok) {
        toast.success(`User ${form.user} added`);
        setForm({ user: "", password: "", level: "User" });
        qc.invalidateQueries({ queryKey: ["vms-device-users", cameraId] });
      } else {
        toast.error(r?.detail || "Could not add user");
      }
    },
    onError: (e) => toast.error(apiError(e, "Add user failed")),
  });

  const del = useMutation({
    mutationFn: (username: string) => vms.deviceMgmt.deleteUser(cameraId, username),
    onSuccess: (r) => {
      if (r?.ok) {
        toast.success("User removed");
        qc.invalidateQueries({ queryKey: ["vms-device-users", cameraId] });
      } else {
        toast.error(r?.detail || "Could not remove user");
      }
    },
    onError: (e) => toast.error(apiError(e, "Delete user failed")),
  });

  if (unsupported) {
    return (
      <p className="text-[11px] text-muted">This device does not expose ONVIF user management.</p>
    );
  }

  return (
    <div className="space-y-3">
      {usersQ.isLoading ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Reading accounts…
        </div>
      ) : (
        <div className="space-y-1.5">
          {users.map((u) => (
            <div key={nameOf(u)} className="flex items-center justify-between rounded-lg border border-card-border bg-hover/30 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{nameOf(u)}</p>
                <p className="text-[11px] text-muted">{u.level || "—"}</p>
              </div>
              {canManage && u.level !== "Administrator" && (
                <button
                  type="button"
                  title="Remove user"
                  onClick={() => del.mutate(nameOf(u))}
                  disabled={del.isPending}
                  className="rounded-sm p-1 text-red-500 hover:bg-red-500/10"
                >
                  <Icon icon="heroicons-outline:trash" className="text-sm" />
                </button>
              )}
            </div>
          ))}
          {users.length === 0 && <p className="text-[11px] text-muted">No accounts reported.</p>}
        </div>
      )}

      {canManage && (
        <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2.5">
          <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">Add account</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field value={form.user} onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))} placeholder="Username" />
            <Field type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="Password" />
            <select
              value={form.level}
              onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))}
              className="rounded-md border border-card-border bg-card px-2 py-1.5 text-sm text-foreground"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              variant="secondary"
              icon="heroicons-outline:user-plus"
              className="!py-1.5 !text-xs"
              disabled={!form.user || !form.password || add.isPending}
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Adding…" : "Add user"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
