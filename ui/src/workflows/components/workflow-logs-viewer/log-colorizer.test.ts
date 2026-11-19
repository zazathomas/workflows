import {colorizeLogLine, detectLogLevel, highlightMatches, passesLevelFilter} from './log-colorizer';

// eslint-disable-next-line no-control-regex -- matching the ESC control character is the point
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';
const DIM = '\u001b[90m';
const BOLD = '\u001b[1m';
const BASE = '\u001b[38;5;250m';
const RESET = '\u001b[0m';
const HIGHLIGHT = '\u001b[1m\u001b[103m\u001b[30m';

describe('detectLogLevel', () => {
    const cases: Array<[string, string | null]> = [
        // logfmt, the format argo's own containers emit
        ['time=2026-10-31T12:44:37.208Z level=INFO msg="hello"', 'info'],
        ['level="warn" msg="careful"', 'warn'],
        ['time=2026-10-31T12:44:37.208Z level=ERROR msg="boom"', 'error'],
        // klog
        ['E0923 12:34:56.789012       1 main.go:42] container failed', 'error'],
        ['I0923 12:34:56.789012       1 main.go:42] started', 'info'],
        // severity words
        ['[ERROR] database unreachable', 'error'],
        ['WARN: disk almost full', 'warn'],
        ['INFO 2026-10-31 everything is fine', 'info'],
        ['2026-10-31 12:44:37,123 WARNING slow query', 'warn'],
        ['2026-10-31T12:44:37Z ERROR database down', 'error'],
        ['panic: runtime error: index out of range', 'fatal'],
        // JSON logs
        ['{"level":"error","msg":"failed"}', 'error'],
        // plain output has no level (and is treated as info by the filter)
        ['custom workflow output', null],
        ['information about the run', null]
    ];
    for (const [line, expected] of cases) {
        test(`detects ${expected ?? 'no level'} in "${line.slice(0, 40)}"`, () => {
            expect(detectLogLevel(line)).toBe(expected);
        });
    }
});

describe('passesLevelFilter', () => {
    test('everything passes at all', () => {
        expect(passesLevelFilter(null, 'all')).toBe(true);
        expect(passesLevelFilter('debug', 'all')).toBe(true);
    });

    test('unlabeled lines are treated as info', () => {
        expect(passesLevelFilter(null, 'info')).toBe(true);
        expect(passesLevelFilter(null, 'warn')).toBe(false);
        expect(passesLevelFilter(null, 'error')).toBe(false);
    });

    test('filters by severity', () => {
        expect(passesLevelFilter('debug', 'info')).toBe(false);
        expect(passesLevelFilter('info', 'info')).toBe(true);
        expect(passesLevelFilter('warn', 'warn')).toBe(true);
        expect(passesLevelFilter('info', 'warn')).toBe(false);
        expect(passesLevelFilter('error', 'error')).toBe(true);
        expect(passesLevelFilter('warn', 'error')).toBe(false);
        expect(passesLevelFilter('fatal', 'error')).toBe(true);
    });
});

describe('colorizeLogLine', () => {
    test('colors the level and dims the timestamp of logfmt lines', () => {
        const line = 'time=2026-10-31T12:44:37.208Z level=INFO msg="workflow emitted this"';
        const colored = colorizeLogLine(line);
        expect(colored).toContain(BOLD + GREEN + 'level=INFO' + RESET);
        expect(colored).toContain(DIM + 'time=2026-10-31T12:44:37.208Z' + RESET);
        expect(colored.startsWith(BASE)).toBe(true);
        // the console must show exactly the original line
        expect(stripAnsi(colored)).toBe(line);
    });

    test('colors errors red and warnings yellow', () => {
        expect(colorizeLogLine('time=2026-10-31T12:44:37.208Z level=ERROR msg="boom"')).toContain(BOLD + RED + 'level=ERROR' + RESET);
        expect(colorizeLogLine('level=warn msg="careful"')).toContain(BOLD + YELLOW + 'level=warn' + RESET);
    });

    test('colors the pod prefix in the all-pods view only', () => {
        const withPrefix = colorizeLogLine('run-1-abc: level=ERROR msg="boom"', {podPrefix: true});
        expect(withPrefix).toContain(CYAN + 'run-1-abc' + RESET);
        expect(stripAnsi(withPrefix)).toBe('run-1-abc: level=ERROR msg="boom"');
        // without the option the same line is left untokenized
        expect(colorizeLogLine('run-1-abc: level=ERROR msg="boom"')).not.toContain(CYAN);
    });

    test('colors severity words and leading timestamps of plain lines', () => {
        const line = '2026-10-31 12:44:37,123 ERROR database down';
        const colored = colorizeLogLine(line);
        expect(colored).toContain(DIM + '2026-10-31 12:44:37,123' + RESET);
        expect(colored).toContain(BOLD + RED + 'ERROR' + RESET);
        expect(stripAnsi(colored)).toBe(line);

        const bracketed = colorizeLogLine('[WARN] disk almost full');
        expect(bracketed).toContain(BOLD + YELLOW + '[WARN]' + RESET);
        expect(stripAnsi(bracketed)).toBe('[WARN] disk almost full');
    });

    test('colors klog headers', () => {
        const line = 'E0923 12:34:56.789012       1 main.go:42] container failed';
        const colored = colorizeLogLine(line);
        expect(colored).toContain(BOLD + RED + 'E' + RESET);
        expect(colored).toContain(DIM + '0923 12:34:56.789012       1 main.go:42]' + RESET);
        expect(stripAnsi(colored)).toBe(line);
    });

    test('leaves plain lines readable on the dark console', () => {
        const line = 'custom workflow output';
        const colored = colorizeLogLine(line + '\n');
        expect(colored).toBe(BASE + line + RESET + '\n');
    });

    test('keeps the trailing newline outside the styling', () => {
        const colored = colorizeLogLine('level=ERROR msg="boom"\n');
        expect(colored.endsWith(RESET + '\n')).toBe(true);
        expect(stripAnsi(colored)).toBe('level=ERROR msg="boom"\n');
    });
});

describe('highlightMatches', () => {
    test('highlights matches without touching the styling escapes', () => {
        const colored = colorizeLogLine('level=ERROR msg="the database is down"');
        const highlighted = highlightMatches(colored, 'database');
        expect(highlighted).toContain(HIGHLIGHT + 'database' + RESET);
        // the yellow highlight must not paint over the escape sequences
        expect(stripAnsi(highlighted)).toBe(stripAnsi(colored));
    });

    test('a pattern spanning styled chunks highlights within each chunk', () => {
        const colored = colorizeLogLine('time=2026-10-31T12:44:37.208Z level=INFO msg="database"');
        const highlighted = highlightMatches(colored, '2026|database');
        expect(highlighted).toContain(HIGHLIGHT + 'database' + RESET);
        expect(highlighted).toContain(HIGHLIGHT + '2026' + RESET);
    });

    test('invalid regular expressions highlight nothing rather than breaking the stream', () => {
        const line = colorizeLogLine('level=ERROR msg="boom"');
        expect(highlightMatches(line, '(')).toBe(line);
        expect(highlightMatches(line, '')).toBe(line);
    });
});
