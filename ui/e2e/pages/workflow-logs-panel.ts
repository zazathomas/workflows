import {Locator, Page} from '@playwright/test';

// How a terminal cell was colored: a palette index (0-255, e.g. the ANSI
// colors the viewer emits), an RGB value, or the terminal default.
export interface CellColor {
    mode: 'palette' | 'rgb' | 'default';
    color: number;
}

// Page object for the Logs side panel (ui/src/workflows/components/workflow-logs-viewer),
// opened from the details page toolbar.
export class WorkflowLogsPanel {
    readonly container: Locator;
    readonly heading: Locator;
    readonly viewer: Locator;

    constructor(page: Page) {
        this.container = page.locator('.workflow-logs-viewer');
        this.heading = this.container.getByRole('heading', {name: 'Logs'});
        // argo-ui's LogsViewer, mounted once the first log entry (or end of
        // stream) replaces the "Waiting for data..." placeholder.
        this.viewer = this.container.locator('.logs-viewer');
    }

    /**
     * The text currently shown in the log terminal, one line per row.
     *
     * argo-ui's LogsViewer renders through xterm, which paints to a canvas, so
     * the text is not in the DOM for a locator to read. It is in xterm's line
     * buffer, and LogsViewer keeps its Terminal on the component instance, which
     * React exposes from the root element through the fiber tree. This reads
     * what a user would get by selecting all and copying, and is polled because
     * xterm writes asynchronously.
     */
    async text(): Promise<string> {
        return this.viewer.evaluate(el => {
            const fiberKey = Object.keys(el).find(key => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? (el as any)[fiberKey] : undefined;
            while (fiber && !fiber.stateNode?.terminal) {
                fiber = fiber.return;
            }
            if (!fiber) {
                throw new Error('no LogsViewer component (with a terminal) above .logs-viewer');
            }
            const buffer = fiber.stateNode.terminal.buffer.active;
            const lines: string[] = [];
            for (let y = 0; y < buffer.length; y++) {
                lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
            }
            return lines.join('\n').trimEnd();
        });
    }

    /**
     * The distinct foreground colors of the non-blank cells in the line
     * containing `text`, in the same xterm buffer `text()` reads. The viewer
     * colors lines with ANSI escapes, which land in the cells' color state.
     */
    async foregroundColors(text: string): Promise<CellColor[]> {
        return this.colors(text, 'foreground');
    }

    /** The distinct background colors of the non-blank cells in the line containing `text`. */
    async backgroundColors(text: string): Promise<CellColor[]> {
        return this.colors(text, 'background');
    }

    private async colors(text: string, kind: 'foreground' | 'background'): Promise<CellColor[]> {
        return this.viewer.evaluate(
            (el: HTMLElement, [needle, wanted]: [string, 'foreground' | 'background']) => {
                const fiberKey = Object.keys(el).find(key => key.startsWith('__reactFiber$'));
                let fiber = fiberKey ? (el as any)[fiberKey] : undefined;
                while (fiber && !fiber.stateNode?.terminal) {
                    fiber = fiber.return;
                }
                if (!fiber) {
                    throw new Error('no LogsViewer component (with a terminal) above .logs-viewer');
                }
                const buffer = fiber.stateNode.terminal.buffer.active;
                for (let y = 0; y < buffer.length; y++) {
                    const line = buffer.getLine(y);
                    if (!line?.translateToString(true).includes(needle)) {
                        continue;
                    }
                    const colors = new Map<string, number>();
                    for (let x = 0; x < line.length; x++) {
                        const cell = line.getCell(x);
                        if (!cell || cell.getChars() === '' || cell.getChars() === ' ') {
                            continue;
                        }
                        if (wanted === 'foreground') {
                            if (cell.isFgPalette()) colors.set('palette:' + cell.getFgColor(), cell.getFgColor());
                            else if (cell.isFgRGB()) colors.set('rgb:' + cell.getFgColor(), cell.getFgColor());
                            else colors.set('default:0', 0);
                        } else {
                            if (cell.isBgPalette()) colors.set('palette:' + cell.getBgColor(), cell.getBgColor());
                            else if (cell.isBgRGB()) colors.set('rgb:' + cell.getBgColor(), cell.getBgColor());
                            else colors.set('default:0', 0);
                        }
                    }
                    return [...colors.keys()].map(key => {
                        const separator = key.indexOf(':');
                        return {mode: key.slice(0, separator), color: Number(key.slice(separator + 1))} as {mode: 'palette' | 'rgb' | 'default'; color: number};
                    });
                }
                throw new Error(`no line containing "${needle}" in the log terminal`);
            },
            [text, kind] as [string, 'foreground' | 'background']
        );
    }
}
