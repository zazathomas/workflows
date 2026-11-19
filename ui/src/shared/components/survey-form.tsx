import * as React from 'react';

import {SurveyQuestion, validateSurveyAnswer} from '../survey';

import './survey-form.scss';

interface SurveyFormProps {
    questions: SurveyQuestion[];
    answers: Record<string, string>;
    onChange: (answers: Record<string, string>) => void;
}

/**
 * AWX-survey-style launch form: typed questions declared on a Job are rendered
 * when the Job is run; the answers become workflow parameters.
 */
export function SurveyForm({questions, answers, onChange}: SurveyFormProps) {
    function setAnswer(question: SurveyQuestion, value: string) {
        onChange({...answers, [question.name]: value});
    }

    function errorFor(question: SurveyQuestion): string | undefined {
        return validateSurveyAnswer(question, answers[question.name]);
    }

    function renderInput(question: SurveyQuestion) {
        const id = `survey-question-${question.name}`;
        const value = answers[question.name] ?? '';
        const error = errorFor(question);
        const describedBy = question.help ? `${id}-help` : undefined;
        const ariaDescribedBy = [describedBy, error ? `${id}-error` : undefined].filter(Boolean).join(' ') || undefined;

        let control: React.ReactNode;
        switch (question.type) {
            case 'textarea':
                control = (
                    <textarea
                        id={id}
                        className='argo-field survey-form__textarea'
                        value={value}
                        onChange={event => setAnswer(question, event.target.value)}
                        aria-invalid={!!error}
                        aria-describedby={ariaDescribedBy}
                    />
                );
                break;
            case 'number':
                control = (
                    <input
                        id={id}
                        type='number'
                        className='argo-field'
                        value={value}
                        onChange={event => setAnswer(question, event.target.value)}
                        aria-invalid={!!error}
                        aria-describedby={ariaDescribedBy}
                    />
                );
                break;
            case 'password':
                control = (
                    <input
                        id={id}
                        type='password'
                        className='argo-field'
                        value={value}
                        onChange={event => setAnswer(question, event.target.value)}
                        autoComplete='new-password'
                        aria-invalid={!!error}
                        aria-describedby={ariaDescribedBy}
                    />
                );
                break;
            case 'select': {
                const options = (question.options || []).map(option => ({value: option, title: option}));
                control = (
                    <select
                        id={id}
                        className='argo-field'
                        value={value}
                        onChange={event => setAnswer(question, event.target.value)}
                        aria-invalid={!!error}
                        aria-describedby={ariaDescribedBy}>
                        <option value='' />
                        {options.map(option => (
                            <option key={option.value} value={option.value}>
                                {option.title}
                            </option>
                        ))}
                    </select>
                );
                break;
            }
            case 'multiselect': {
                const selected = value ? value.split(',').filter(Boolean) : [];
                control = (
                    <div className='survey-form__options' role='group' aria-label={question.label || question.name}>
                        {(question.options || []).map(option => (
                            <label key={option}>
                                <input
                                    type='checkbox'
                                    checked={selected.includes(option)}
                                    onChange={event => {
                                        const next = event.target.checked ? selected.concat(option) : selected.filter(item => item !== option);
                                        setAnswer(question, next.join(','));
                                    }}
                                />{' '}
                                {option}
                            </label>
                        ))}
                    </div>
                );
                break;
            }
            case 'boolean':
                control = (
                    <input
                        id={id}
                        type='checkbox'
                        checked={value === 'true'}
                        onChange={event => setAnswer(question, event.target.checked ? 'true' : 'false')}
                        aria-invalid={!!error}
                        aria-describedby={ariaDescribedBy}
                    />
                );
                break;
            default:
                control = (
                    <input
                        id={id}
                        type='text'
                        className='argo-field'
                        value={value}
                        onChange={event => setAnswer(question, event.target.value)}
                        aria-invalid={!!error}
                        aria-describedby={ariaDescribedBy}
                    />
                );
        }

        const labelElement =
            question.type === 'multiselect' ? (
                <span className='survey-form__label'>
                    {question.label || question.name}
                    {question.required && (
                        <span className='survey-form__required' aria-hidden='true'>
                            {' '}
                            *
                        </span>
                    )}
                </span>
            ) : (
                <label htmlFor={id} className='survey-form__label'>
                    {question.label || question.name}
                    {question.required && (
                        <span className='survey-form__required' aria-hidden='true'>
                            {' '}
                            *
                        </span>
                    )}
                </label>
            );

        return (
            <div key={question.name} className='survey-form__question'>
                {labelElement}
                {question.help && (
                    <small id={`${id}-help`} className='survey-form__help'>
                        {question.help}
                    </small>
                )}
                {control}
                {error && (
                    <span id={`${id}-error`} className='survey-form__error' role='alert'>
                        {error}
                    </span>
                )}
            </div>
        );
    }

    return <div className='survey-form'>{questions.map(renderInput)}</div>;
}
