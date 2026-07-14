"use client";

// Audit log — a read-only, paginated record of actions across the platform.
// Thin orchestrator: owns the paged query + page state, gates the admin-only
// RetentionCard behind the settings.manage permission, and renders AuditTable.
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/kit";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import RetentionCard from "./components/RetentionCard";
import AuditTable from "./components/AuditTable";

const PAGE_SIZE = 25;

export default function AuditPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);

  const audit = useQuery({
    queryKey: ["audit", page],
    queryFn: () =>
      api.get("/audit", { params: { page, page_size: PAGE_SIZE } }).then((r) => r.data),
    placeholderData: keepPreviousData,
    // Always show the latest entries when landing on this page (no stale cache).
    staleTime: 0,
    refetchOnMount: "always",
  });

  const data = audit.data;
  const items = data?.items || [];

  return (
    <div>
      {can("settings.manage") && <RetentionCard />}
      <AuditTable items={items} loading={audit.isLoading} />

      {items.length > 0 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-muted">
            Page {data?.page ?? page}
            {data?.pages ? ` of ${data.pages}` : ""}
            {data?.total != null ? ` · ${data.total} entries` : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon="heroicons-outline:chevron-left"
              disabled={!data?.has_prev || audit.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              disabled={!data?.has_next || audit.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
