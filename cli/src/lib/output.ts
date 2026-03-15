// ANSI color helpers — respects NO_COLOR env var

const noColor = "NO_COLOR" in process.env;

const code = (n: number) => (s: string) => noColor ? s : `\x1b[${n}m${s}\x1b[0m`;

export const bold = code(1);
export const dim = code(2);
export const green = code(32);
export const yellow = code(33);
export const red = code(31);
export const cyan = code(36);

export function formatTable(
  headers: string[],
  rows: string[][],
  gap = 2,
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const headerLine = headers
    .map((h, i) => bold(h.padEnd(widths[i])))
    .join(" ".repeat(gap));

  const dataLines = rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(" ".repeat(gap)),
  );

  return [headerLine, ...dataLines].join("\n");
}
