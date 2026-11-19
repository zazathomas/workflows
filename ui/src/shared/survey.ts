import {ANNOTATION_SURVEY} from './annotations';

/**
 * Launch-form (\"survey\") support: a Job template can declare a form of
 * questions in an annotation; the answers become workflow parameters when the
 * Job is run. Patterned after AWX surveys and Rundeck job options.
 *
 * Example annotation value:
 *
 * [
 *   {\"name\": \"environment\", \"label\": \"Environment\", \"type\": \"select\", \"required\": true, \"options\": [\"dev\", \"prod\"]},
 *   {\"name\": \"replicas\", \"type\": \"number\", \"default\": \"3\", \"help\": \"Number of replicas\"},
 *   {\"name\": \"note\", \"type\": \"textarea\"}
 * ]
 */

export const SURVEY_QUESTION_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'password'] as const;

export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

export interface SurveyQuestion {
    // The workflow parameter the answer is assigned to.
    name: string;
    // Display label; defaults to the name.
    label?: string;
    type: SurveyQuestionType;
    required?: boolean;
    // Default answer, used when the question is not prompted.
    default?: string;
    // Help text shown under the input.
    help?: string;
    // Choices for select/multiselect questions.
    options?: string[];
    // A regular expression the answer must match.
    pattern?: string;
    // When false the question is not asked; the default (if any) is used.
    prompt?: boolean;
}

export function parseSurvey(annotations?: Record<string, string>): SurveyQuestion[] {
    const raw = annotations?.[ANNOTATION_SURVEY];
    if (!raw) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    const questions: SurveyQuestion[] = [];
    for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const candidate = entry as Partial<SurveyQuestion>;
        if (!candidate.name || typeof candidate.name !== 'string') {
            continue;
        }
        const type = SURVEY_QUESTION_TYPES.includes(candidate.type as SurveyQuestionType) ? (candidate.type as SurveyQuestionType) : 'text';
        const question: SurveyQuestion = {name: candidate.name, type, prompt: candidate.prompt === undefined ? true : !!candidate.prompt};
        if (typeof candidate.label === 'string' && candidate.label) {
            question.label = candidate.label;
        }
        if (candidate.required !== undefined) {
            question.required = !!candidate.required;
        }
        if (candidate.default !== undefined && candidate.default !== null) {
            question.default = String(candidate.default);
        }
        if (typeof candidate.help === 'string' && candidate.help) {
            question.help = candidate.help;
        }
        if (Array.isArray(candidate.options)) {
            question.options = candidate.options.filter(option => typeof option === 'string');
        }
        if (typeof candidate.pattern === 'string' && candidate.pattern) {
            question.pattern = candidate.pattern;
        }
        questions.push(question);
    }
    // later questions win if names collide, matching how duplicate parameters behave
    return questions.filter((question, index) => questions.findIndex(other => other.name === question.name) === index);
}

/**
 * Validate an answer against a question. Returns an error message, or undefined
 * when the answer is acceptable.
 */
export function validateSurveyAnswer(question: SurveyQuestion, value?: string): string | undefined {
    const answer = value !== undefined && value !== null ? value : '';
    if (!answer) {
        return question.required ? `${questionLabel(question)} is required` : undefined;
    }
    if (question.type === 'number' && Number.isNaN(Number(answer))) {
        return `${questionLabel(question)} must be a number`;
    }
    if (question.pattern) {
        try {
            if (!new RegExp(question.pattern).test(answer)) {
                return `${questionLabel(question)} must match ${question.pattern}`;
            }
        } catch {
            // an invalid pattern in the Job cannot be the user's fault; do not block the run
        }
    }
    return undefined;
}

/**
 * The default answers for a survey: the declared defaults, with unprompted
 * questions always using their default.
 */
export function surveyDefaults(questions: SurveyQuestion[]): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const question of questions) {
        if (question.default !== undefined) {
            defaults[question.name] = question.default;
        }
    }
    return defaults;
}

export function questionLabel(question: SurveyQuestion): string {
    return question.label || question.name;
}

/** True when every prompted question has a valid answer. */
export function surveyIsValid(questions: SurveyQuestion[], answers: Record<string, string>): boolean {
    return promptedQuestions(questions).every(question => validateSurveyAnswer(question, answers[question.name]) === undefined);
}

/** Questions that the user should be asked; unprompted questions use their default. */
export function promptedQuestions(questions: SurveyQuestion[]): SurveyQuestion[] {
    return questions.filter(question => question.prompt !== false);
}
