"use client";

// UPLOADING AND REMOVING YOUR OWN PHOTO — one copy, previously two.
//
// The same two handlers lived in the nav dock's user menu and in the account
// page's profile tab, character for character, down to the toast text. Both call
// the same endpoint and both have to reload the session afterwards, so what they
// shared was not incidental — it was the whole behaviour.
//
// `e.target.value = ""` is the part worth keeping visible. Without it a file
// input holds the last selection, so picking the SAME photo again fires no change
// event and the upload silently does not happen. That is a confusing bug to hit
// and an easy line to drop when copying.
import { useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { api, apiError } from "@/lib/api";

export interface Avatar {
  /** True while either call is in flight — both controls disable on it. */
  busy: boolean;
  /** onChange for an `<input type="file">`. */
  pick: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  remove: () => Promise<void>;
}

/** `reload` re-reads the session, because the photo is part of it and nothing
 *  else will notice it changed. */
export function useAvatar(reload: () => Promise<unknown> | unknown): Avatar {
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      await reload();
      toast.success(done);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    pick: async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Cleared BEFORE the early return, so re-picking the same file works even
      // when the first attempt was cancelled.
      e.target.value = "";
      if (!file) return;
      await run(() => {
        const fd = new FormData();
        fd.append("file", file);
        return api.post("/auth/me/avatar", fd);
      }, "Photo updated");
    },
    remove: () => run(() => api.delete("/auth/me/avatar"), "Photo removed"),
  };
}
