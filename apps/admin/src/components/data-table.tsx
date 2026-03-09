import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  isLoading,
  onLoadMore,
  hasMore = false,
  onRowClick,
  emptyMessage = "No data found.",
}: {
  data: T[];
  columns: { key: string; header: string; render?: (row: T) => React.ReactNode }[];
  isLoading?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}) {
  if (isLoading && data.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    return <div className="text-center py-10 text-muted-foreground">{emptyMessage}</div>;
  }

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key}>{col.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, i) => (
            <TableRow key={(row.id as string) || i} className={onRowClick ? "cursor-pointer hover:bg-accent" : ""} onClick={() => onRowClick?.(row)}>
              {columns.map((col) => (
                <TableCell key={col.key}>{col.render ? col.render(row) : String(row[col.key] ?? "—")}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {hasMore && onLoadMore && (
        <div className="flex justify-center py-4">
          <Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
            {isLoading ? "Loading..." : "Load More"}
          </Button>
        </div>
      )}
    </div>
  );
}
