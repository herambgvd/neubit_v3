import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminApi } from "@/lib/api";
import type { BillingSummary, Invoice, Paged, Plan } from "@/lib/types";
import { renderWithProviders } from "@/test/render";

import BillingPage from "./page";

const summary: BillingSummary = {
  mrr_cents: 250000,
  currency: "USD",
  active_subscriptions: 4,
  plan_count: 2,
  outstanding_cents: 50000,
  overdue_count: 1,
  paid_last_30d_cents: 120000,
};

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: "p1",
    key: "pro",
    name: "Pro",
    description: "For growing teams",
    price_cents: 9900,
    currency: "USD",
    interval: "monthly",
    features: { anpr: true },
    limits: { max_users: 50 },
    is_active: true,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "i1",
    tenant_id: "t1",
    number: "INV-0001",
    amount_cents: 9900,
    currency: "USD",
    status: "issued",
    period_start: null,
    period_end: null,
    issued_at: "2026-01-02T00:00:00Z",
    due_at: "2026-02-01T00:00:00Z",
    paid_at: null,
    notes: null,
    created_at: "2026-01-02T00:00:00Z",
    tenant_name: "Acme",
    ...over,
  };
}

const invoicePage = (items: Invoice[]): Paged<Invoice> => ({
  items,
  total: items.length,
  page: 1,
  page_size: 20,
});

beforeEach(() => {
  vi.spyOn(adminApi, "billingSummary").mockResolvedValue(summary);
  vi.spyOn(adminApi, "listPlans").mockImplementation(async () => [plan()]);
  vi.spyOn(adminApi, "listInvoices").mockImplementation(async () => invoicePage([invoice()]));
});

describe("billing summary", () => {
  it("formats money in the reported currency, not raw cents", async () => {
    renderWithProviders(<BillingPage />);

    expect(await screen.findByText("$2,500.00")).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    expect(screen.getByText("2 plans in catalog")).toBeInTheDocument();
  });
});

describe("plans", () => {
  it("shows a plan's price, interval and quota", async () => {
    renderWithProviders(<BillingPage />);

    expect(await screen.findByText("$99.00")).toBeInTheDocument();
    expect(screen.getByText("/ mo")).toBeInTheDocument();
    expect(screen.getByText("50 users")).toBeInTheDocument();
    expect(screen.getByText("anpr")).toBeInTheDocument();
  });

  it("marks an inactive plan", async () => {
    vi.spyOn(adminApi, "listPlans").mockImplementation(async () => [plan({ is_active: false })]);

    renderWithProviders(<BillingPage />);

    expect(await screen.findByText("Inactive")).toBeInTheDocument();
  });

  it("locks the key when editing and sends the price in cents", async () => {
    const updatePlan = vi.spyOn(adminApi, "updatePlan").mockResolvedValue(plan());

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("button", { name: /edit plan/i }));

    expect(await screen.findByDisplayValue("pro")).toBeDisabled();
    const price = screen.getByDisplayValue("99");
    await userEvent.clear(price);
    await userEvent.type(price, "149.50");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(updatePlan).toHaveBeenCalledWith("pro", expect.objectContaining({ price_cents: 14950 }))
    );
  });

  it("rejects a key that is not slug-shaped, before calling the API", async () => {
    const createPlan = vi.spyOn(adminApi, "createPlan");

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new plan/i }));
    await userEvent.type(await screen.findByPlaceholderText("pro"), "Not A Key");
    await userEvent.type(screen.getByPlaceholderText("Pro"), "Enterprise");
    await userEvent.click(screen.getByRole("button", { name: /create plan/i }));

    await waitFor(() => expect(createPlan).not.toHaveBeenCalled());
  });

  it("confirms before deleting a plan", async () => {
    const deletePlan = vi.spyOn(adminApi, "deletePlan");

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("button", { name: /delete plan/i }));

    expect(await screen.findByText(/must be reassigned first/i)).toBeInTheDocument();
    expect(deletePlan).not.toHaveBeenCalled();
  });
});

describe("invoices", () => {
  it("offers Mark paid and Void for an outstanding invoice", async () => {
    const markInvoicePaid = vi.spyOn(adminApi, "markInvoicePaid").mockResolvedValue(invoice());

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /invoices/i }));
    await userEvent.click(await screen.findByRole("button", { name: /mark paid/i }));

    await waitFor(() => expect(markInvoicePaid).toHaveBeenCalledWith("i1"));
  });

  it("stops offering Mark paid once an invoice is paid, but can still void it", async () => {
    vi.spyOn(adminApi, "listInvoices").mockImplementation(async () =>
      invoicePage([invoice({ status: "paid", paid_at: "2026-01-03T00:00:00Z" })])
    );

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /invoices/i }));
    await screen.findByText("INV-0001");

    expect(screen.queryByRole("button", { name: /mark paid/i })).not.toBeInTheDocument();
    // Void stays available: a wrongly-marked-paid invoice has to be correctable.
    expect(screen.getByRole("button", { name: /^void$/i })).toBeInTheDocument();
  });

  it("offers no action at all on an already-voided invoice", async () => {
    vi.spyOn(adminApi, "listInvoices").mockImplementation(async () =>
      invoicePage([invoice({ status: "void" })])
    );

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /invoices/i }));
    await screen.findByText("INV-0001");

    expect(screen.queryByRole("button", { name: /mark paid/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^void$/i })).not.toBeInTheDocument();
  });

  it("confirms before voiding — a void cannot be undone", async () => {
    const voidInvoice = vi.spyOn(adminApi, "voidInvoice");

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /invoices/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^void$/i }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/excluded from outstanding balances/i)).toBeInTheDocument();
    expect(voidInvoice).not.toHaveBeenCalled();

    await userEvent.click(dialog.getByRole("button", { name: /void invoice/i }));

    await waitFor(() => expect(voidInvoice).toHaveBeenCalledWith("i1"));
  });

  it("says there are no invoices rather than rendering an empty table", async () => {
    vi.spyOn(adminApi, "listInvoices").mockImplementation(async () => invoicePage([]));

    renderWithProviders(<BillingPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /invoices/i }));

    expect(await screen.findByText(/no invoices/i)).toBeInTheDocument();
  });
});
