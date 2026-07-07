"use client";

// Clickable stat tiles (counts by status/category). Used by the incident list;
// reusable for notifications, audit, any list with a summary + filter-by-tile.
//
//   <StatsStrip
//     stats={[{key:"", label:"Total", count:42}, {key:"active", label:"Active", count:5}]}
//     active={status} onSelect={setStatus} />

export function StatsStrip({ stats = [], active, onSelect, className = "" }) {
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 ${className}`}>
      {stats.map((s) => {
        const isActive = active === s.key;
        return (
          <button
            key={s.key || "all"}
            type="button"
            onClick={() => onSelect?.(s.key)}
            className={`rounded-xl border px-3 py-2.5 text-left transition ${
              isActive ? "border-foreground bg-hover" : "border-card-border hover:bg-hover"
            }`}
          >
            <div className={`text-lg font-semibold ${s.color || "text-foreground"}`}>{s.count ?? 0}</div>
            <div className="text-[11px] text-muted">{s.label}</div>
          </button>
        );
      })}
    </div>
  );
}

export default StatsStrip;
