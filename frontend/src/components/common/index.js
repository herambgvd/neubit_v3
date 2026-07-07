// Barrel for the shared, reusable composite components. Import from
// "@/components/common". Low-level primitives (Button, Modal, Table, …) still
// live in "@/components/ui/kit"; these are the higher-level patterns that were
// previously copy-pasted across features.
export { Field, FieldLabel, fieldClass, areaClass } from "./Field";
export { TabBar } from "./TabBar";
export { MasterDetail, ListPanel, EmptyDetail } from "./MasterDetail";
export { StatsStrip } from "./StatsStrip";
