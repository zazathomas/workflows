import {ANNOTATION_SURVEY} from './annotations';
import {parseSurvey, surveyDefaults, validateSurveyAnswer} from './survey';

describe('survey', () => {
    it('returns no questions without the annotation', () => {
        expect(parseSurvey(undefined)).toEqual([]);
        expect(parseSurvey({})).toEqual([]);
        expect(parseSurvey({[ANNOTATION_SURVEY]: 'not json'})).toEqual([]);
        expect(parseSurvey({[ANNOTATION_SURVEY]: '{"name": "object-not-array"}'})).toEqual([]);
    });

    it('parses questions and applies safe defaults', () => {
        const questions = parseSurvey({
            [ANNOTATION_SURVEY]: JSON.stringify([
                {name: 'environment', type: 'select', required: true, options: ['dev', 'prod']},
                {name: 'replicas', type: 'number', default: 3},
                {name: 'note', type: 'unknown-type'},
                {noName: true},
                'not an object'
            ])
        });
        expect(questions).toEqual([
            {name: 'environment', type: 'select', required: true, options: ['dev', 'prod'], prompt: true},
            {name: 'replicas', type: 'number', default: '3', prompt: true},
            {name: 'note', type: 'text', prompt: true}
        ]);
    });

    it('drops duplicate question names', () => {
        const questions = parseSurvey({[ANNOTATION_SURVEY]: JSON.stringify([{name: 'a'}, {name: 'a', type: 'number'}])});
        expect(questions).toHaveLength(1);
        expect(questions[0].type).toBe('text');
    });

    it('collects declared defaults', () => {
        const defaults = surveyDefaults(parseSurvey({[ANNOTATION_SURVEY]: JSON.stringify([{name: 'a', default: 'x'}, {name: 'b'}])}));
        expect(defaults).toEqual({a: 'x'});
    });

    describe('validateSurveyAnswer', () => {
        it('requires required answers', () => {
            const question = {name: 'env', type: 'select' as const, required: true};
            expect(validateSurveyAnswer(question, undefined)).toBe('env is required');
            expect(validateSurveyAnswer(question, '')).toBe('env is required');
            expect(validateSurveyAnswer(question, 'dev')).toBeUndefined();
        });

        it('allows empty optional answers', () => {
            expect(validateSurveyAnswer({name: 'env', type: 'text'}, '')).toBeUndefined();
        });

        it('checks numbers', () => {
            expect(validateSurveyAnswer({name: 'replicas', type: 'number'}, 'three')).toBe('replicas must be a number');
            expect(validateSurveyAnswer({name: 'replicas', type: 'number'}, '3')).toBeUndefined();
        });

        it('checks patterns', () => {
            expect(validateSurveyAnswer({name: 'id', type: 'text', pattern: '^[a-z]+$'}, 'ABC')).toBe('id must match ^[a-z]+$');
            expect(validateSurveyAnswer({name: 'id', type: 'text', pattern: '^[a-z]+$'}, 'abc')).toBeUndefined();
        });

        it('does not block on an invalid pattern', () => {
            expect(validateSurveyAnswer({name: 'id', type: 'text', pattern: '('}, 'anything')).toBeUndefined();
        });

        it('prefers the label in messages', () => {
            expect(validateSurveyAnswer({name: 'id', label: 'Identifier', type: 'text', required: true}, '')).toBe('Identifier is required');
        });
    });
});
