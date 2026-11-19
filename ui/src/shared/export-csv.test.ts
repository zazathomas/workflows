import {toCsv} from './export-csv';

describe('toCsv', () => {
    it('renders headers and rows', () => {
        expect(
            toCsv(
                ['a', 'b'],
                [
                    ['1', 'x'],
                    ['2', 'y']
                ]
            )
        ).toBe('a,b\r\n1,x\r\n2,y\r\n');
    });

    it('escapes commas, quotes and newlines', () => {
        expect(toCsv(['msg'], [['a,b']])).toBe('msg\r\n"a,b"\r\n');
        expect(toCsv(['msg'], [['say "hi"']])).toBe('msg\r\n"say ""hi"""\r\n');
        expect(toCsv(['msg'], [['two\r\nlines']])).toBe('msg\r\n"two\r\nlines"\r\n');
    });

    it('renders empty cells for missing values', () => {
        expect(toCsv(['a', 'b'], [[undefined, null]])).toBe('a,b\r\n,\r\n');
    });
});
