import {ACTION_CONTAINER_ANNOTATION, ACTION_MARKER_ANNOTATION, configFromAnnotations, parseRunActionLine, submitAnnotations} from './run-actions';

const marker = 'NEEDS_USER_ACTION:';
const event = {kind: 'open-url', id: 'auth-1', title: 'Sign in', url: 'https://github.com/login/device', code: 'ABCD-1234', expiresAt: '2030-01-01T00:00:00Z'};
const line = (value: unknown) => marker + JSON.stringify(value);

it('requires an opt-in marker and a valid container, and creates safe submit annotations', () => {
    expect(configFromAnnotations()).toBeNull();
    expect(configFromAnnotations({[ACTION_MARKER_ANNOTATION]: 'BAD,marker'})).toBeNull();
    expect(configFromAnnotations({[ACTION_MARKER_ANNOTATION]: marker, [ACTION_CONTAINER_ANNOTATION]: 'other-container'})).toEqual({marker, container: 'other-container'});
    expect(submitAnnotations({marker, container: 'main'})).toBe('workflows-ui-action-marker=NEEDS_USER_ACTION:,workflows-ui-action-container=main');
});

it('parses the marked event and rejects expired or replay-unsafe values', () => {
    expect(parseRunActionLine(line(event), marker, ['github.com'], Date.parse('2028-01-01'))).toEqual({...event, host: 'github.com'});
    expect(parseRunActionLine(line({...event, expiresAt: '2020-01-01T00:00:00Z'}), marker, ['github.com'])).toBeNull();
    expect(parseRunActionLine(line({...event, id: 'bad id'}), marker, ['github.com'])).toBeNull();
    expect(parseRunActionLine(line({...event, url: 42}), marker, ['github.com'])).toBeNull();
    expect(parseRunActionLine('other:' + JSON.stringify(event), marker, ['github.com'])).toBeNull();
    expect(parseRunActionLine(marker + '{broken', marker, ['github.com'])).toBeNull();
    expect(parseRunActionLine(marker + 'x'.repeat(4096), marker, ['github.com'])).toBeNull();
});

it.each([
    'https://github.com.evil.example/login/device',
    'https://evil.example/login/device',
    'https://github.com:444/login/device',
    'https://user:secret@github.com/login/device',
    'http://github.com/login/device',
    'javascript:alert(1)'
])('refuses an unsafe or unapproved URL: %s', url => {
    expect(parseRunActionLine(line({...event, url}), marker, ['github.com'])).toBeNull();
});

it('supports direct links without a code and refuses links when the administrator has not allowed hosts', () => {
    const direct = {kind: 'open-url', id: 'auth-1', title: 'Sign in', url: 'https://github.com/login/device?user_code=ABCD'};
    expect(parseRunActionLine(line(direct), marker, ['github.com'])).toEqual({kind: 'open-url', id: 'auth-1', title: 'Sign in', url: direct.url, host: 'github.com'});
    expect(parseRunActionLine(line(event), marker, [])).toBeNull();
});
