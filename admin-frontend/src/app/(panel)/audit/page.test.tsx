import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { AuditEntry, Paged } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import AuditPage from "./page";

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "a1",
    tenant_id: "t1",
    actor_id: "u1",
    actor_email: "root@neubit",
    actor_name: "Root Admin",
    actor_type: "user",
    action: "tenant.suspend",
    target_type: "tenant",
    target_id: "t1",
    meta: {},
    ts: "2026-01-02T03:04:05Z",
    ...over,
  };
}

const page = (items: AuditEntry[], over: Partial<Paged<AuditEntry>> = {}): Paged<AuditEntry> => ({
  items,
  total: items.length,
  page: 1,
  page_size: 20,
  ...over,
});

beforeEach(() => {
  vi.spyOn(adminApi, "listAudit").mockResolvedValue(page([entry()]));
});

describe("audit page", () => {
  // Regression: the Actor column read `row.original.actor`, which the API does
  // not send — every row rendered "—". It reads actor_name/actor_email now.
  it("shows who performed the action", async () => {
    renderWithProviders(<AuditPage />);

    expect(await screen.findByText("Root Admin")).toBeInTheDocument();
  });

  it("falls back to the actor's email when there is no display name", async () => {
    vi.spyOn(adminApi, "listAudit").mockResolvedValue(page([entry({ actor_name: null })]));

    renderWithProviders(<AuditPage />);

    expect(await screen.findByText("root@neubit")).toBeInTheDocument();
  });

  it("shows a dash only when the entry genuinely has no actor", async () => {
    vi.spyOn(adminApi, "listAudit").mockResolvedValue(
      page([entry({ actor_name: null, actor_email: null })])
    );

    renderWithProviders(<AuditPage />);

    await screen.findByText("tenant.suspend");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("filters by tenant only once the form is submitted", async () => {
    const listAudit = vi.spyOn(adminApi, "listAudit").mockResolvedValue(page([entry()]));
    renderWithProviders(<AuditPage />);
    await screen.findByText("Root Admin");
    listAudit.mockClear();

    await userEvent.type(screen.getByPlaceholderText(/tenant_id/i), "tenant-42");
    // Typing alone must not refetch — that would be a request per keystroke.
    expect(listAudit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /apply/i }));

    await waitFor(() =>
      expect(listAudit).toHaveBeenCalledWith({ tenantId: "tenant-42", page: 1 })
    );
  });

  it("derives the page count from the envelope's total and page size", async () => {
    vi.spyOn(adminApi, "listAudit").mockResolvedValue(
      page([entry()], { total: 57, page_size: 20 })
    );

    renderWithProviders(<AuditPage />);

    // 57 rows at 20 per page = 3 pages, and page 1 cannot go back.
    expect(await screen.findByText(/page 1 \/ 3/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prev/i })).toBeDisabled();
  });

  it("reports a failed load instead of an empty log", async () => {
    vi.spyOn(adminApi, "listAudit").mockRejectedValue(new Error("gateway down"));

    renderWithProviders(<AuditPage />);

    expect(await screen.findByText(/gateway down/i)).toBeInTheDocument();
    expect(screen.queryByText(/no audit entries/i)).not.toBeInTheDocument();
  });
});
