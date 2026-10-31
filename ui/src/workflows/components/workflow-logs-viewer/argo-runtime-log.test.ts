import {isArgoRuntimeLog} from './argo-runtime-log';

describe('Argo runtime log detection', () => {
    const runtime = 'time=2026-10-31T12:44:37.208Z level=INFO msg="waiting for signals" argo=true signalPath=/var/run/argo/ctr/main/signal';

    test('identifies executor messages without relying on a pod-name prefix', () => {
        expect(isArgoRuntimeLog(runtime)).toBe(true);
        expect(isArgoRuntimeLog('time="2026-10-31T12:44:37Z" level=warn msg="saving outputs" template="a b" argo=true')).toBe(true);
    });

    test('preserves job stdout/stderr and INFO messages', () => {
        expect(isArgoRuntimeLog('workflow completed')).toBe(false);
        expect(isArgoRuntimeLog('time=2026-10-31T12:44:37Z level=INFO msg="job completed"')).toBe(false);
        expect(isArgoRuntimeLog('time=2026-10-31T12:44:37Z level=INFO msg="argo=true"')).toBe(false);
        expect(isArgoRuntimeLog('time=2026-10-31T12:44:37Z level=INFO msg="hello" note="contains argo=true here"')).toBe(false);
        expect(isArgoRuntimeLog('NEEDS_USER_ACTION:{"id":"one","url":"https://github.com/login/device"}')).toBe(false);
        expect(isArgoRuntimeLog('argo=true level=INFO msg="job output"')).toBe(false);
    });

    test('does not mistake substrings or malformed records for Argo fields', () => {
        expect(isArgoRuntimeLog('time=now level=INFO msg=argo=true')).toBe(false);
        expect(isArgoRuntimeLog('time=now level=INFO msg="unterminated argo=true')).toBe(false);
        expect(isArgoRuntimeLog('time=now level=INFO msg="work" notargo=true')).toBe(false);
        expect(isArgoRuntimeLog('time=now level=INFO msg="work" argo=trueish')).toBe(false);
    });
});
