"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";

import { NotificationItem } from "./components/NotificationItem";

export default function NotificationsPage() {
  const qc = useQueryClient();

  const notifications = useQuery({
    queryKey: ["messaging-notifications"],
    queryFn: () =>
      api.get("/messaging/notifications", { params: { page_size: 100 } }).then((r) => r.data),
    refetchInterval: 15000,
  });

  const items = notifications.data?.items || [];
  const unread = items.filter((n) => !n.read);

  const markRead = useMutation({
    mutationFn: (id) => api.post(`/messaging/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messaging-notifications"] }),
    onError: (e) => toast.error(apiError(e)),
  });

  const markAll = useMutation({
    mutationFn: () => Promise.all(unread.map((n) => api.post(`/messaging/notifications/${n.id}/read`))),
    onSuccess: () => {
      toast.success("All notifications marked read");
      qc.invalidateQueries({ queryKey: ["messaging-notifications"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Alerts and updates from across the platform."
        actions={
          <Button
            variant="secondary"
            icon="heroicons-outline:check-circle"
            disabled={markAll.isPending || unread.length === 0}
            onClick={() => markAll.mutate()}
          >
            {markAll.isPending ? "Marking…" : `Mark all read${unread.length ? ` (${unread.length})` : ""}`}
          </Button>
        }
      />

      {notifications.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Card className="p-2">
          <EmptyState
            icon="heroicons-outline:bell"
            title="You're all caught up"
            subtitle="New notifications will show up here."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              onMarkRead={markRead.mutate}
              marking={markRead.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
