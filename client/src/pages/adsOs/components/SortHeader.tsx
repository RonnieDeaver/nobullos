// Shared sortable column header for the dashboard tables (was duplicated as `Th`
// in all three dashboards). Generic over the dashboard's sort-key union.
// Verbatim port of the bundle's frontend/src/components/SortHeader.tsx.
export type SortDir = "asc" | "desc";

export function SortHeader<K extends string>({
  label,
  k,
  sort,
  onSort,
  num,
}: {
  label: string;
  k: K;
  sort: { key: K; dir: SortDir };
  onSort: (k: K) => void;
  num?: boolean;
}) {
  const active = sort.key === k;
  return (
    <th
      className={num ? "num" : ""}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button className={`dash-sort${active ? " active" : ""}`} onClick={() => onSort(k)}>
        {label}
        <span className="dash-caret">{active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}
