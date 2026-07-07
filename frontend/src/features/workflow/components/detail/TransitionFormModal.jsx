"use client";

// Modal that collects a transition's form_data before applying it. Resolves the
// field list from the transition's inline form_config or a referenced form
// definition, validates required fields, then hands the values to onSubmit.
import { useState } from "react";
import { Icon } from "@iconify/react";
import { Button } from "@/components/ui/kit";
import { titleize } from "@/lib/format";
import { stateId, stateName } from "./StateMachine";
import FormFieldInput, { fieldKey, fieldRequired } from "./FormFieldInput";

export default function TransitionFormModal({ transition, states, formList, pending, onCancel, onSubmit }) {
  // Resolve the field list: inline form_config, or a referenced form definition.
  const formRef = transition.form_id ?? transition.form_config?.form_id;
  const referenced = formList.find((f) => (f.id ?? f.form_id) === formRef);
  const fields =
    transition.form_config?.fields || referenced?.fields || [];

  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});

  function setField(key, v) {
    setValues((p) => ({ ...p, [key]: v }));
    if (errors[key]) setErrors((p) => ({ ...p, [key]: undefined }));
  }

  function submit(e) {
    e.preventDefault();
    const next = {};
    for (const f of fields) {
      const k = fieldKey(f);
      if (fieldRequired(f) && (values[k] === undefined || values[k] === "" || values[k] === null)) {
        next[k] = `${f.label || k} is required`;
      }
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    onSubmit(values);
  }

  const toName =
    transition.to_state_name ||
    stateName(states.find((s) => stateId(s) === (transition.to_state_id ?? transition.to_state))) ||
    transition.to_state;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onCancel} />
      <div className="relative w-full max-w-lg rounded-xl bg-card border border-card-border shadow-2xl animate-modal-in flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{transition.name || "Apply transition"}</h3>
            <p className="text-xs text-muted mt-0.5">Move to {titleize(toName)}</p>
          </div>
          <button onClick={onCancel} className="text-muted hover:text-foreground transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 px-6 py-5 space-y-4 overflow-y-auto">
            {fields.length === 0 ? (
              <p className="text-sm text-muted">Confirm to apply this transition.</p>
            ) : (
              fields.map((f) => {
                const k = fieldKey(f);
                return (
                  <FormFieldInput
                    key={k}
                    field={f}
                    value={values[k]}
                    error={errors[k]}
                    onChange={(v) => setField(k, v)}
                  />
                );
              })
            )}
          </div>
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
            <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Applying…" : "Apply transition"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
