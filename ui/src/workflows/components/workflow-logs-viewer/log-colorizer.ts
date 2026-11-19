// Styling for the xterm-based logs console (argo-ui's LogsViewer). Every
// function here preserves the visible text exactly: they only interleave ANSI
// escape sequences, so selecting and copying from the console reproduces the
// original line, and any reader that ignores escapes (tests, `grep`) still
// sees the raw log.

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
// Comfortable default text color for the dark console (256-color light gray).
const BASE_COLOR = '\u001b[38;5;250m';
// Timestamps, and trace/debug severity words.
const DIM_COLOR = '\u001b[90m';
const CYAN_COLOR = '\u001b[36m';
const GREEN_COLOR = '\u001b[32m';
const YELLOW_COLOR = '\u001b[33m';
const RED_COLOR = '\u001b[31m';
// Bold black on bright yellow: the classic search-match highlight, readable on
// the dark console.
const HIGHLIGHT_COLOR = '\u001b[1m\u001b[103m\u001b[30m';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// Severity order used by the minimum-level filter.
export const LEVEL_ORDER: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    fatal: 5
};

export type MinimumLevel = 'all' | 'info' | 'warn' | 'error';

// Common level spellings (logfmt, klog, logrus, zap, python, ...).
const LEVELS: Record<string, LogLevel> = {
    trace: 'trace',
    debug: 'debug',
    info: 'info',
    notice: 'info',
    warn: 'warn',
    warning: 'warn',
    err: 'error',
    error: 'error',
    fatal: 'fatal',
    critical: 'fatal',
    crit: 'fatal',
    panic: 'fatal',
    alert: 'fatal',
    emerg: 'fatal'
};

export function normalizeLevel(raw: string): LogLevel | null {
    return LEVELS[raw.toLowerCase()] ?? null;
}

function levelColor(level: LogLevel): string {
    switch (level) {
        case 'trace':
        case 'debug':
            return DIM_COLOR;
        case 'info':
            return GREEN_COLOR;
        case 'warn':
            return YELLOW_COLOR;
        default:
            return RED_COLOR;
    }
}

/**
 * Whether a line of `level` severity (or of unrecognized severity, `null`)
 * should be shown when the console is set to show `minimum` and above.
 * Unlabeled lines are treated as info: they are plain container output, which
 * is exactly what the console exists to show.
 */
export function passesLevelFilter(level: LogLevel | null, minimum: MinimumLevel): boolean {
    if (minimum === 'all') {
        return true;
    }
    const effective = level ?? 'info';
    return LEVEL_ORDER[effective] >= LEVEL_ORDER[minimum];
}

// logfmt `level=warn` or `level="WARN"` — the format argo's own containers emit.
const LOGFMT_LEVEL = /(?:^|\s)level=("?)([A-Za-z]+)\1(?=\s|$)/;
// klog (kubelet, controller, scheduler): `I0923 12:34:56.789012 1 main.go:42] ...`
const KLOG_HEADER = /^([IWEF])(\d{4} \d{2}:\d{2}:\d{2}\.\d+)/;
const KLOG_LEVELS: Record<string, LogLevel> = {I: 'info', W: 'warn', E: 'error', F: 'fatal'};
// A severity word at the very start of what is left: `INFO `, `[WARN]`, `ERROR:`.
// The match never includes surrounding whitespace, so the visible text is preserved.
const LEVEL_WORD = /^(\[?)(trace|debug|info|notice|warning|warn|error|err|critical|crit|fatal|panic)(\]?)(?=$|[\s:,])/i;
// An ISO-8601 timestamp at the very start: `2026-10-31T12:44:37Z`, `2026-10-31 12:44:37,123`.
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:[zZ]|[+-]\d{2}:?\d{2})?(?:,\d+)?/;

/**
 * The severity of a log line, from whichever structured format it happens to
 * use — logfmt (`level=`), klog (`E0923 ...`), a leading severity word
 * (`[ERROR]`, `WARN:`), or JSON (`{"level":"error"}`). Plain lines have no
 * level and are treated as info by the filter.
 */
export function detectLogLevel(content: string): LogLevel | null {
    const line = content.trimStart();
    if (!line) {
        return null;
    }

    const logfmt = LOGFMT_LEVEL.exec(line);
    if (logfmt) {
        return normalizeLevel(logfmt[2]);
    }

    const klog = KLOG_HEADER.exec(line);
    if (klog) {
        return KLOG_LEVELS[klog[1]];
    }

    const word = LEVEL_WORD.exec(line);
    if (word) {
        return normalizeLevel(word[2]);
    }

    const afterTimestamp = LEADING_TIMESTAMP.exec(line);
    if (afterTimestamp) {
        const wordAfterTimestamp = LEVEL_WORD.exec(line.slice(afterTimestamp[0].length).trimStart());
        if (wordAfterTimestamp) {
            return normalizeLevel(wordAfterTimestamp[2]);
        }
    }

    if (line.startsWith('{') && line.length <= 4096) {
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.level === 'string') {
                return normalizeLevel(parsed.level);
            }
        } catch {
            // not JSON — plain text
        }
    }
    return null;
}

type Emit = (text: string, style: string) => void;
type EmitPlain = (text: string) => void;

// A line is tokenized as logfmt only when it opens with one of these pairs;
// anything else is prose that happens to contain an `=`.
const LOGFMT_START = /^(time|ts|timestamp|level|msg)=("[^"]*"|\S*)/;
// logfmt `key=value` / `key="quoted value"` pairs, styled per key.
const LOGFMT_TOKEN = /^(time|ts|timestamp|level)=(?:"(?:[^"\\]|\\.)*"|\S*)/;

function colorizeLogfmt(rest: string, emit: Emit, plain: EmitPlain): boolean {
    if (!LOGFMT_START.test(rest)) {
        return false;
    }
    let index = 0;
    while (index < rest.length) {
        if (rest[index] === ' ') {
            plain(' ');
            index++;
            continue;
        }
        const match = LOGFMT_TOKEN.exec(rest.slice(index));
        if (!match) {
            // a word that is not a styled pair (msg=..., argo=true, prose)
            const end = rest.indexOf(' ', index);
            const stop = end === -1 ? rest.length : end;
            plain(rest.slice(index, stop));
            index = stop;
            continue;
        }
        const [text, key] = match;
        if (key === 'level') {
            const raw = text.slice('level='.length);
            const level = normalizeLevel(raw.startsWith('"') ? raw.slice(1, -1) : raw);
            if (level) {
                emit(text, BOLD + levelColor(level));
            } else {
                plain(text);
            }
        } else {
            emit(text, DIM_COLOR);
        }
        index += text.length;
    }
    return true;
}

function colorizeKlog(rest: string, emit: Emit, plain: EmitPlain): boolean {
    const match = KLOG_HEADER.exec(rest);
    if (!match) {
        return false;
    }
    const level = KLOG_LEVELS[match[1]];
    emit(match[1], BOLD + levelColor(level));
    // dim the timestamp, source file and thread id up to the closing `]`
    const bracket = rest.indexOf(']');
    const headerEnd = bracket === -1 ? match[0].length : bracket + 1;
    emit(rest.slice(1, headerEnd), DIM_COLOR);
    plain(rest.slice(headerEnd));
    return true;
}

function colorizeSeverityWord(rest: string, emit: Emit, plain: EmitPlain): void {
    let index = 0;
    // an optional leading timestamp: `2026-10-31 12:44:37,123 ERROR ...`
    const timestamp = LEADING_TIMESTAMP.exec(rest);
    if (timestamp) {
        emit(timestamp[0], DIM_COLOR);
        index = timestamp[0].length;
        const whitespace = rest.slice(index).match(/^\s+/);
        if (whitespace) {
            plain(whitespace[0]);
            index += whitespace[0].length;
        }
    }
    const word = LEVEL_WORD.exec(rest.slice(index));
    if (word) {
        const level = normalizeLevel(word[2]);
        if (level) {
            emit(word[0], BOLD + levelColor(level));
            index += word[0].length;
        }
    }
    plain(rest.slice(index));
}

export interface ColorizeOptions {
    /** The line carries a `pod-name: ` prefix (the all-pods view), colored to keep pods apart. */
    podPrefix?: boolean;
}

/**
 * Colors a single log line (which may end with `\n`) for the dark console:
 * the pod prefix (all-pods view), timestamps and the severity token are
 * styled; the message itself keeps the base text color. The rendered text is
 * unchanged — only escapes are added.
 */
export function colorizeLogLine(line: string, options: ColorizeOptions = {}): string {
    const trailing = line.endsWith('\n') ? '\n' : '';
    let rest = trailing ? line.slice(0, -1) : line;
    const parts: string[] = [BASE_COLOR];

    const emit = (text: string, style: string) => parts.push(style, text, RESET, BASE_COLOR);
    const plain = (text: string) => parts.push(text);

    if (options.podPrefix) {
        const separator = rest.indexOf(': ');
        if (separator > 0) {
            emit(rest.slice(0, separator), CYAN_COLOR);
            plain(rest.slice(separator, separator + 2));
            rest = rest.slice(separator + 2);
        }
    }

    if (colorizeLogfmt(rest, emit, plain)) {
        // fully styled
    } else if (!colorizeKlog(rest, emit, plain)) {
        colorizeSeverityWord(rest, emit, plain);
    }

    parts.push(RESET);
    return parts.join('') + trailing;
}

// eslint-disable-next-line no-control-regex -- matching the ESC control character is the point
const ANSI_ESCAPE = /(\u001b\[[0-9;]*m)/;

/**
 * Highlights `grep` (a regular expression) matches in an already colorized
 * line, without letting the pattern match (or eat) the escape sequences that
 * carry the styling: the line is styled chunk by chunk, visible text only.
 * An invalid pattern highlights nothing rather than breaking the log stream.
 */
export function highlightMatches(line: string, grep: string): string {
    if (!grep) {
        return line;
    }
    let matcher: RegExp;
    try {
        matcher = new RegExp(grep, 'g');
    } catch {
        return line;
    }
    return line
        .split(ANSI_ESCAPE)
        .map((chunk, index) => (index % 2 === 1 ? chunk : chunk.replace(matcher, match => HIGHLIGHT_COLOR + match + RESET + BASE_COLOR)))
        .join('');
}
