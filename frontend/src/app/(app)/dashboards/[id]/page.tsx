// One dashboard. `DashboardView` reads `?edit=1` for its mode, so this route
// serves both the viewer and the builder — a link to a dashboard is a link to
// VIEW it, which is what gets shared.
//
// `params` is a Promise in Next 16, so the id is awaited here and the client
// component takes it as a plain prop.
import DashboardView from "@/features/dashboards/DashboardView";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DashboardView id={id} />;
}
