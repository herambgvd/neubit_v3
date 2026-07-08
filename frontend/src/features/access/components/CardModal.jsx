"use client";

// Create / edit a card on an instance (write-through to the upstream controller).
// Ported from neubit_v2's card-modal.jsx: card code (required) + status, a searchable
// cardholder picker (selecting one auto-sets status Used; status Free clears holder),
// reader-function UID, technology type (0–255), description. Rethemed to v3 tokens.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, idOf } from "@/lib/format";
import { gates } from "../api";
import { CARD_STATUSES } from "../constants";

const cardKey = (c) => idOf(c, "dds_uid", "card_id", "id");

export default function CardModal({ instanceId, card, onClose, onSuccess }) {
  const isEdit = !!card;
  const qc = useQueryClient();

  const [form, setForm] = useState({
    card_code: card?.card_code || "",
    status: card?.status || "Free",
    cardholder_uid: card?.cardholder_uid || "",
    reader_function_uid: card?.reader_function_uid || "",
    technology_type: card?.technology_type ?? "",
    description: card?.description || "",
  });
  const [errors, setErrors] = useState({});
  const [chSearch, setChSearch] = useState("");
  const [chOpen, setChOpen] = useState(false);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const cardholdersQ = useQuery({
    queryKey: ["ac-cardholders", instanceId],
    queryFn: () => gates.cardholders.list(instanceId, { limit: 500 }),
    enabled: !!instanceId,
    staleTime: 60_000,
  });
  const allCardholders = asItems(cardholdersQ.data);

  const filteredCardholders = useMemo(() => {
    const term = chSearch.toLowerCase();
    if (!term) return allCardholders;
    return allCardholders.filter((c) =>
      [c.first_name, c.last_name, c.name, c.employee_id, c.cardholder_id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [allCardholders, chSearch]);

  const selectedCardholder = useMemo(
    () => allCardholders.find((c) => c.cardholder_id === form.cardholder_uid) || null,
    [allCardholders, form.cardholder_uid],
  );

  const create = useMutation({
    mutationFn: () =>
      gates.cards.create(instanceId, {
        card_code: form.card_code.trim(),
        status: form.status,
        cardholder_uid: form.cardholder_uid.trim() || undefined,
        reader_function_uid: form.reader_function_uid.trim() || undefined,
        technology_type: form.technology_type === "" ? undefined : Number(form.technology_type),
        description: form.description.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Card created");
      qc.invalidateQueries({ queryKey: ["ac-cards", instanceId] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Create failed")),
  });

  const update = useMutation({
    mutationFn: () => {
      const body = {};
      if (form.card_code !== (card.card_code || "")) body.card_code = form.card_code.trim();
      if (form.status !== card.status) body.status = form.status;
      if (form.cardholder_uid !== (card.cardholder_uid || "")) body.cardholder_uid = form.cardholder_uid.trim() || null;
      if (form.reader_function_uid !== (card.reader_function_uid || ""))
        body.reader_function_uid = form.reader_function_uid.trim() || null;
      const tt = form.technology_type === "" ? null : Number(form.technology_type);
      if (tt !== (card.technology_type ?? null)) body.technology_type = tt;
      if (form.description !== (card.description || "")) body.description = form.description.trim() || null;
      return gates.cards.update(instanceId, cardKey(card), body);
    },
    onSuccess: () => {
      toast.success("Card updated");
      qc.invalidateQueries({ queryKey: ["ac-cards", instanceId] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const validate = () => {
    const next = {};
    if (!form.card_code.trim()) next.card_code = "Required";
    if (
      form.technology_type !== "" &&
      (Number.isNaN(Number(form.technology_type)) || Number(form.technology_type) < 0 || Number(form.technology_type) > 255)
    )
      next.technology_type = "0–255";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    if (isEdit) update.mutate();
    else create.mutate();
  };

  const isPending = create.isPending || update.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit · ${card.card_code}` : "New Card"}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ac-card-form" variant="success" disabled={isPending}>
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create card"}
          </Button>
        </>
      }
    >
      <form id="ac-card-form" noValidate onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Card Code" required value={form.card_code} onChange={(e) => set({ card_code: e.target.value })} placeholder="e.g. 0123456" error={errors.card_code} />
          <Field
            as="select"
            label="Status"
            value={form.status}
            onChange={(e) => {
              const newStatus = e.target.value;
              set({ status: newStatus, cardholder_uid: newStatus === "Free" ? "" : form.cardholder_uid });
            }}
            options={CARD_STATUSES.map((s) => ({ value: s, label: s }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Cardholder</FieldLabel>
            <CardholderPicker
              selected={selectedCardholder}
              filtered={filteredCardholders}
              loading={cardholdersQ.isLoading}
              search={chSearch}
              open={chOpen}
              onSearch={setChSearch}
              onToggle={() => setChOpen((o) => !o)}
              onSelect={(ch) => {
                set({ cardholder_uid: ch ? ch.cardholder_id : "", status: ch ? "Used" : form.status });
                setChOpen(false);
                setChSearch("");
              }}
            />
          </div>
          <Field label="Reader Function UID" value={form.reader_function_uid} onChange={(e) => set({ reader_function_uid: e.target.value })} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Technology Type" type="number" value={form.technology_type} onChange={(e) => set({ technology_type: e.target.value })} placeholder="0–255" error={errors.technology_type} />
        </div>

        <Field label="Description" value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </form>
    </Modal>
  );
}

function CardholderPicker({ selected, filtered, loading, search, open, onSearch, onToggle, onSelect }) {
  const label = (ch) => `${ch.first_name ? ch.first_name + " " : ""}${ch.last_name || ch.name || ""}`.trim() || ch.cardholder_id;
  return (
    <div className="relative mt-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-muted"
      >
        <span className={selected ? "text-foreground" : "text-muted"}>{selected ? label(selected) : "— none —"}</span>
        <span className="flex items-center gap-1">
          {selected && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), onSelect(null))}
              className="rounded p-0.5 text-muted hover:text-red-500"
            >
              <Icon icon="heroicons-outline:x-mark" className="text-xs" />
            </span>
          )}
          <Icon icon="heroicons-outline:chevron-down" className="text-sm text-muted" />
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-card-border bg-card shadow-lg">
          <div className="p-1.5">
            <input
              autoFocus
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search by name / ID…"
              className="w-full rounded-md border border-field bg-transparent px-2 py-1 text-xs text-foreground placeholder:text-muted outline-none focus:border-muted"
            />
          </div>
          <ul className="max-h-44 overflow-y-auto">
            {loading && (
              <li className="flex items-center justify-center p-3 text-xs text-muted">
                <Icon icon="svg-spinners:180-ring" className="mr-1.5 text-xs" /> Loading…
              </li>
            )}
            {!loading && filtered.length === 0 && (
              <li className="p-2 text-center text-xs text-muted/70">No cardholders found</li>
            )}
            {!loading &&
              filtered.map((ch) => {
                const sub = ch.employee_id ? `ID: ${ch.employee_id}` : `${String(ch.cardholder_id).slice(0, 18)}…`;
                return (
                  <li key={ch.cardholder_id} onClick={() => onSelect(ch)} className="flex cursor-pointer flex-col px-3 py-1.5 text-xs hover:bg-hover">
                    <span className="font-medium text-foreground">{label(ch)}</span>
                    <span className="text-muted/70">{sub}</span>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}
