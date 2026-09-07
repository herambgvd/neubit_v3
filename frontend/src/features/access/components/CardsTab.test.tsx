/**
 * A card delete propagates to the upstream controller, so it is confirmed, and a
 * card that is in use cannot be deleted at all. The list rows arrive as DDS mirror
 * rows (PascalCase `dto`), which the api module folds to snake_case — a fold that
 * fails renders a table of dashes rather than an error.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { httpError, paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import CardsTab from "./CardsTab";

/** One row exactly as the mirror serves it: the verbatim DDS DTO. */
const mirrorCard = (over: Record<string, unknown> = {}) => ({
  remote_uid: "uid-1",
  dto: {
    UID: "uid-1",
    CardCode: "10001",
    Status: "Free",
    CardholderUID: "",
    Description: "Spare",
    ...over,
  },
});

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /access/instances/inst1/cards": paged([
      mirrorCard(),
      mirrorCard({ UID: "uid-2", CardCode: "10002", Status: "Used", CardholderUID: "ch-1" }),
    ]),
    "GET /access/instances/inst1/cardholders": paged([
      { dto: { UID: "ch-1", FirstName: "Ada", LastName: "Lovelace" } },
    ]),
    "DELETE /access/instances/inst1/cards/*": {},
  });
});

describe("reading the mirror rows", () => {
  it("shows the card code and status the DDS DTO carries under other names", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);

    expect(await screen.findByText("10001")).toBeInTheDocument();
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it("resolves the assigned cardholder to a name rather than a bare uid", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
  });
});

describe("a failed load", () => {
  it("reports the failure instead of showing an empty card list", async () => {
    stub.set({ "GET /access/instances/inst1/cards": () => httpError(502, "Controller unreachable") });

    renderWithProviders(<CardsTab instanceId="inst1" />);

    expect(await screen.findByText("Controller unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No cards")).not.toBeInTheDocument();
  });
});

describe("revoking a card", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);
    await screen.findByText("10001");

    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(await screen.findByText(/delete it on the upstream controller/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /access/instances/inst1/cards/*")).toHaveLength(0);
  });

  it("addresses the controller UID, which is the write-path id", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);
    await screen.findByText("10001");
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    await userEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

    await waitFor(() =>
      expect(stub.matching("DELETE /access/instances/inst1/cards/*")).toHaveLength(1)
    );
    expect(stub.matching("DELETE /access/instances/inst1/cards/*")[0].url).toBe(
      "/access/instances/inst1/cards/uid-1"
    );
  });

  // A card that is issued to someone must be released before it can be removed.
  it("cannot be revoked at all while it is in use", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);
    await screen.findByText("10002");

    expect(screen.getAllByRole("button", { name: "Cannot delete a card in use" })[0]).toBeDisabled();
  });
});

describe("the toolbar filters", () => {
  it("narrows by card code without going back to the controller", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);
    await screen.findByText("10001");
    const before = stub.matching("GET /access/instances/inst1/cards").length;

    await userEvent.type(screen.getByPlaceholderText("Search by card code"), "10002");

    await waitFor(() => expect(screen.queryByText("10001")).not.toBeInTheDocument());
    expect(screen.getByText("10002")).toBeInTheDocument();
    expect(stub.matching("GET /access/instances/inst1/cards")).toHaveLength(before);
  });

  it("narrows by status the same way", async () => {
    renderWithProviders(<CardsTab instanceId="inst1" />);
    await screen.findByText("10001");

    await userEvent.selectOptions(screen.getByRole("combobox"), "Used");

    await waitFor(() => expect(screen.queryByText("10001")).not.toBeInTheDocument());
    expect(screen.getByText("10002")).toBeInTheDocument();
  });
});
