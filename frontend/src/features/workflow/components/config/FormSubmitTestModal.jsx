"use client";

// Fill the form being built and run the same client-side validation the backend
// applies (required / type / regex via validation.pattern), then show the
// resulting form_data JSON — or per-field errors. No API call.
import { Modal, Button } from "@/components/ui/kit";
import { validateForm } from "../../lib/formValidation";

export default function FormSubmitTestModal({ open, onClose, fields, values }) {
  const { errors, formData, valid } = validateForm(fields, values || {});
  const errEntries = Object.entries(errors);
  const dataEntries = Object.entries(formData);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Test submit"
      footer={<Button variant="secondary" onClick={onClose} className="!px-3 !py-1.5 text-xs">Close</Button>}
    >
      <div className="space-y-4">
        <div className={`rounded-lg border px-3 py-2 text-sm font-medium ${valid ? "border-green-500/40 bg-green-500/10 text-green-500" : "border-red-500/40 bg-red-500/10 text-red-500"}`}>
          {valid ? "Valid — this form would submit." : `${errEntries.length} field(s) failed validation.`}
        </div>

        {errEntries.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Errors</p>
            <ul className="space-y-1.5">
              {errEntries.map(([key, msg]) => (
                <li key={key} className="rounded-md border border-card-border bg-hover/40 px-3 py-2 text-xs">
                  <code className="font-mono text-foreground">{key}</code>
                  <span className="ml-2 text-red-500">{msg}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">form_data (JSON)</p>
          {dataEntries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-card-border px-4 py-6 text-sm text-muted">No values collected yet.</div>
          ) : (
            <pre className="max-h-72 overflow-auto rounded-lg border border-card-border bg-hover/40 p-3 text-xs font-mono text-foreground">
              {JSON.stringify(formData, null, 2)}
            </pre>
          )}
        </div>

        <p className="text-[11px] text-muted/70">
          This payload is what would be passed to the transition&apos;s <code className="font-mono">form_data</code> when this form is attached to a workflow transition.
        </p>
      </div>
    </Modal>
  );
}
