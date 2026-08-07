import type { ReactNode } from "react";

export function DiagnosticTable({ caption, headers, children }: { caption: string; headers: readonly string[]; children: ReactNode }) {
  return (
    <div className="episode-table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
