"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Database, Download, FileUp, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError, tokens } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  PageHeader,
} from "@/components/ui";

const CONFIRM_WORD = "RESTORE";

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function DatabasePage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Database"
        description="Back up and restore the platform control database (tenants, users, licenses, settings)."
      />
      <div className="space-y-6">
        <ExportCard />
        <ImportCard />
      </div>
    </div>
  );
}

function ExportCard() {
  const exportDb = useMutation({
    mutationFn: () => adminApi.exportDatabase(),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `neubit_control_${today()}.sql`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Backup downloaded");
    },
    onError: (err) => toast.error(apiError(err, "Export failed")),
  });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-accent">
          <Download className="h-4 w-4" />
        </div>
        <div>
          <CardTitle>Export backup</CardTitle>
          <p className="mt-0.5 text-xs text-muted">Download a plain-SQL dump of the control database.</p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-md text-sm text-muted">
          The dump includes every tenant, user, license, module and platform setting. Store it
          somewhere safe — it contains sensitive data.
        </p>
        <Button loading={exportDb.isPending} onClick={() => exportDb.mutate()}>
          {!exportDb.isPending && <Download className="h-4 w-4" />}
          Download backup
        </Button>
      </CardContent>
    </Card>
  );
}

function ImportCard() {
  const router = useRouter();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState(null);

  const importDb = useMutation({
    mutationFn: () => adminApi.importDatabase(file),
    onSuccess: (res) => {
      setResult(res);
      setConfirmOpen(false);
      setConfirmText("");
      if (res?.ok) {
        // The restore replaced the users/sessions tables — force a fresh login.
        toast.success("Database restored — please sign in again");
        tokens.clear();
        setTimeout(() => router.replace("/login"), 1200);
      } else {
        toast.error("Restore reported errors — see output");
      }
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast.error(apiError(err, "Import failed"));
    },
  });

  function onPick(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/\.sql$/i.test(f.name)) {
      toast.error("Please choose a .sql backup file");
      return;
    }
    setFile(f);
    setResult(null);
  }

  return (
    <Card className="border-danger/30">
      <CardHeader className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger/30 bg-danger/10 text-danger">
          <Upload className="h-4 w-4" />
        </div>
        <div>
          <CardTitle>Restore from backup</CardTitle>
          <p className="mt-0.5 text-xs text-muted">Overwrite the control database with a SQL backup.</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This is destructive and irreversible. The restore drops and recreates tables, replacing all
            current tenants, users and settings. Export a fresh backup first. The restore is atomic — if it
            can&apos;t acquire locks (platform busy) it safely aborts within ~20s and changes nothing, so
            run it during low activity. Sign out and back in afterwards.
          </span>
        </div>

        <input ref={fileRef} type="file" accept=".sql" onChange={onPick} className="hidden" />
        <div className="flex items-center gap-3 rounded-lg border border-card-border bg-card px-3.5 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-card-border bg-hover text-muted">
            <FileUp className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{file ? file.name : "No file selected"}</div>
            <div className="text-xs text-muted">{file ? `${(file.size / 1024).toFixed(1)} KB` : "Choose a .sql backup"}</div>
          </div>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            {file ? "Change" : "Choose file"}
          </Button>
        </div>

        <div className="flex justify-end">
          <Button variant="danger" disabled={!file} onClick={() => setConfirmOpen(true)}>
            <Upload className="h-4 w-4" /> Restore database
          </Button>
        </div>

        {result && (
          <div className="rounded-lg border border-card-border bg-hover p-3">
            <div className="mb-1 text-xs font-medium text-foreground">
              {result.ok ? "Restore completed" : `Restore failed (exit ${result.exit_code})`}
            </div>
            {result.output && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted">
                {result.output}
              </pre>
            )}
          </div>
        )}
      </CardContent>

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o) setConfirmText("");
          setConfirmOpen(o);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader
            title="Restore the database?"
            description={`This permanently overwrites the control database with “${file?.name}”. Type ${CONFIRM_WORD} to confirm.`}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmText.trim().toUpperCase() === CONFIRM_WORD) importDb.mutate();
            }}
          >
            <Field label={`Type ${CONFIRM_WORD} to continue`}>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoFocus
                autoComplete="off"
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={importDb.isPending}
                disabled={confirmText.trim().toUpperCase() !== CONFIRM_WORD}
              >
                {!importDb.isPending && <Upload className="h-4 w-4" />}
                Restore now
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
