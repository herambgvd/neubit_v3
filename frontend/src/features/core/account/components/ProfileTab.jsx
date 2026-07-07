"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Avatar, Badge, Button, Card, Input } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function ProfileTab() {
  const { user, reload } = useAuth();
  const [name, setName] = useState(user?.full_name || "");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => setName(user?.full_name || ""), [user?.full_name]);

  const save = useMutation({
    mutationFn: () => api.patch("/auth/me", { full_name: name }),
    onSuccess: async () => {
      await reload();
      toast.success("Profile updated");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  async function onPickAvatar(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.post("/auth/me/avatar", fd);
      await reload();
      toast.success("Photo updated");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setUploading(false);
    }
  }
  async function removeAvatar() {
    setUploading(true);
    try {
      await api.delete("/auth/me/avatar");
      await reload();
      toast.success("Photo removed");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3 items-start">
      <Card className="p-6 space-y-4 lg:col-span-1">
        <h2 className="text-sm font-semibold text-foreground">Profile photo</h2>
        <div className="flex flex-col items-center gap-4 py-2">
          <Avatar src={user?.avatar_url} name={user?.full_name || user?.email} size={96} />
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickAvatar} />
            <Button variant="secondary" icon="heroicons-outline:camera" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Uploading…" : user?.avatar_url ? "Change" : "Upload"}
            </Button>
            {user?.avatar_url && (
              <Button variant="ghost" icon="heroicons-outline:trash" disabled={uploading} onClick={removeAvatar}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-6 space-y-5 lg:col-span-2">
        <h2 className="text-sm font-semibold text-foreground">Details</h2>
        <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <span className="block text-sm font-medium text-foreground mb-1.5">Email</span>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted truncate">{user?.email}</span>
              <Badge color={user?.email_verified ? "green" : "amber"}>
                {user?.email_verified ? "Verified" : "Unverified"}
              </Badge>
            </div>
          </div>
          <div>
            <span className="block text-sm font-medium text-foreground mb-1.5">Role</span>
            <span className="text-sm text-muted">{user?.role?.name || "—"}</span>
          </div>
        </div>

        <div className="pt-2">
          <Button
            variant="primary"
            disabled={save.isPending || name === (user?.full_name || "")}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
