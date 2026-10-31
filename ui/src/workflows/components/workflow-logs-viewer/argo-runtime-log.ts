// Executor messages use this structured text format and mark themselves with
// argo=true. Check fields outside msg so user output such as `msg="argo=true"`
// remains visible. Container stdout/stderr is otherwise left untouched.
const argoPrefix = /^time=(?:"[^"]+"|\S+)\s+level=(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+msg=/i;
export function isArgoRuntimeLog(content: string): boolean {
    const prefix = argoPrefix.exec(content);
    if (!prefix) return false;

    const messageAndFields = content.slice(prefix[0].length);
    let messageEnd = 0;
    if (messageAndFields.startsWith('"')) {
        let escaped = false;
        for (let i = 1; i < messageAndFields.length; i++) {
            if (escaped) escaped = false;
            else if (messageAndFields[i] === '\\') escaped = true;
            else if (messageAndFields[i] === '"') {
                messageEnd = i + 1;
                break;
            }
        }
        if (!messageEnd) return false;
    } else {
        messageEnd = messageAndFields.search(/\s/);
        if (messageEnd < 0) return false;
    }

    const fields = messageAndFields.slice(messageEnd);
    let inQuotes = false;
    let escaped = false;
    for (let i = 0; i < fields.length; i++) {
        const char = fields[i];
        if (escaped) escaped = false;
        else if (char === '\\' && inQuotes) escaped = true;
        else if (char === '"') inQuotes = !inQuotes;
        else if (!inQuotes && fields.startsWith('argo=true', i) && (i === 0 || /\s/.test(fields[i - 1])) && (i + 9 === fields.length || /\s/.test(fields[i + 9]))) {
            return true;
        }
    }
    return false;
}
