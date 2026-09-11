/**
 * THE LINE THAT IS EASY TO LOSE IN A COPY.
 *
 * A file input remembers its last selection, so choosing the SAME photo twice
 * fires no change event and the second upload never happens. Clearing
 * `e.target.value` is what prevents it, and it has to happen BEFORE the early
 * return — otherwise a cancelled picker leaves the old value behind and the next
 * pick of that file is ignored too.
 *
 * This lived twice, character for character. Now it lives once, and the awkward
 * bit is tested rather than remembered.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useAvatar } from "./useAvatar";

const post = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...a: unknown[]) => post(...a), delete: (...a: unknown[]) => del(...a) },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function event(file: File | null) {
  return { target: { files: file ? [file] : [], value: "photo.png" } } as unknown as React.ChangeEvent<HTMLInputElement>;
}

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
});

describe("picking a photo", () => {
  it("uploads it and reloads the session, because the photo is part of it", async () => {
    const reload = vi.fn();
    const { result } = renderHook(() => useAvatar(reload));
    await act(() => result.current.pick(event(new File(["x"], "a.png"))));

    expect(post).toHaveBeenCalledWith("/auth/me/avatar", expect.any(FormData));
    expect(reload).toHaveBeenCalled();
  });

  it("clears the input even when the picker was cancelled", async () => {
    // The early return must not skip the clear, or the file that was almost
    // chosen can never be chosen again.
    const e = event(null);
    const { result } = renderHook(() => useAvatar(vi.fn()));
    await act(() => result.current.pick(e));

    expect(e.target.value).toBe("");
    expect(post).not.toHaveBeenCalled();
  });

  it("stops being busy when the upload fails", async () => {
    // A stuck `busy` leaves both controls disabled with no way back.
    post.mockRejectedValue(new Error("too large"));
    const { result } = renderHook(() => useAvatar(vi.fn()));
    await act(() => result.current.pick(event(new File(["x"], "a.png"))));

    expect(result.current.busy).toBe(false);
  });
});

describe("removing a photo", () => {
  it("deletes it and reloads", async () => {
    const reload = vi.fn();
    const { result } = renderHook(() => useAvatar(reload));
    await act(() => result.current.remove());

    expect(del).toHaveBeenCalledWith("/auth/me/avatar");
    expect(reload).toHaveBeenCalled();
  });
});
