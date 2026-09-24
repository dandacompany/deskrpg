"use client";
import { useMemo } from "react";

import { useT } from "@/lib/i18n";

import { CSV_MAX_ROWS, parseCsv } from "../artifact-view-model";

/** Renders CSV as a table — uses the first row as the header and truncates at `CSV_MAX_ROWS` rows. */
export default function CsvViewer({ text }: { text: string }) {
  const t = useT();
  const { rows, truncated } = useMemo(() => parseCsv(text), [text]);
  const [head, ...body] = rows;
  return (
    <div className="text-xs">
      {truncated && (
        <p className="mb-2 text-npc-dark">{t("artifacts.csvTruncated", { rows: CSV_MAX_ROWS })}</p>
      )}
      <div className="overflow-auto">
        <table className="border-collapse">
          {head && (
            <thead>
              <tr>
                {head.map((cell, i) => (
                  <th
                    key={i}
                    className="border border-border px-2 py-1 text-left font-semibold bg-surface-raised"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className="border border-border px-2 py-1 whitespace-pre-wrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
