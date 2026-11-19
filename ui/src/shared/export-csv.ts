/**
 * CSV export for lists (Rundeck-style activity export).
 */

function csvCell(value: string | number | undefined | null): string {
    const text = value === undefined || value === null ? '' : String(value);
    if (/[",\n\r]/.test(text)) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

export function toCsv(headers: string[], rows: (string | number | undefined | null)[][]): string {
    const lines = [headers.map(csvCell).join(',')];
    for (const row of rows) {
        lines.push(headers.map((_, index) => csvCell(row[index])).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

export function downloadCsv(filename: string, contents: string) {
    const blob = new Blob([contents], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}
