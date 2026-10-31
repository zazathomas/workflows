import {Page} from 'argo-ui/src/components/page/page';
import {ChartOptions} from 'chart.js';

import 'chartjs-plugin-annotation';

import * as React from 'react';
import {useContext, useEffect, useRef, useState} from 'react';
import {Bar, ChartData} from 'react-chartjs-2';
import {RouteComponentProps} from 'react-router-dom';

import {uiUrl} from '../shared/base';
import {ErrorNotice} from '../shared/components/error-notice';
import {InfoIcon} from '../shared/components/fa-icons';
import {ZeroState} from '../shared/components/zero-state';
import {Context} from '../shared/context';
import {formatDuration} from '../shared/duration';
import {Footnote} from '../shared/footnote';
import {historyUrl} from '../shared/history';
import * as nsUtils from '../shared/namespaces';
import {services} from '../shared/services';
import {useCollectEvent} from '../shared/use-collect-event';
import {ReportFilters} from './reports-filters';
import {workflowsToChartData} from './workflows-to-chart-data';

import './reports.scss';

interface Chart {
    data: ChartData<any>;
    options: ChartOptions;
    workflowNames: string[];
    fullNames: string[];
}

const limit = 100;

const roundedHistogramBars = {
    beforeDatasetsDraw(chart: any) {
        const ctx = chart.chart.ctx;

        chart.data.datasets.forEach((dataset: any, datasetIndex: number) => {
            const meta = chart.getDatasetMeta(datasetIndex);
            if (meta.hidden) {
                return;
            }

            meta.data.forEach((bar: any, index: number) => {
                const model = bar._model;
                if (!model || model.skip) {
                    return;
                }

                const top = Math.min(model.y, model.base);
                const bottom = Math.max(model.y, model.base);
                const halfWidth = model.width / 2;
                const radius = Math.min(8, halfWidth, Math.max(0, bottom - top));
                const color = Array.isArray(dataset.backgroundColor) ? dataset.backgroundColor[index] : dataset.backgroundColor;
                const gradient = ctx.createLinearGradient(0, top, 0, bottom);
                gradient.addColorStop(0, '#ffffff');
                gradient.addColorStop(0.12, color);
                gradient.addColorStop(1, color);

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(model.x - halfWidth + radius, top);
                ctx.lineTo(model.x + halfWidth - radius, top);
                ctx.quadraticCurveTo(model.x + halfWidth, top, model.x + halfWidth, top + radius);
                ctx.lineTo(model.x + halfWidth, bottom);
                ctx.lineTo(model.x - halfWidth, bottom);
                ctx.lineTo(model.x - halfWidth, top + radius);
                ctx.quadraticCurveTo(model.x - halfWidth, top, model.x - halfWidth + radius, top);
                ctx.closePath();
                ctx.fillStyle = gradient;
                ctx.fill();
                ctx.restore();
            });
        });

        return false;
    }
};

export function Reports({match, location, history}: RouteComponentProps<any>) {
    const queryParams = new URLSearchParams(location.search);
    const {navigation} = useContext(Context);

    // state for URL, query, and label parameters
    const isFirstRender = useRef(true);
    const [namespace, setNamespace] = useState<string>(nsUtils.getNamespace(match.params.namespace) || '');
    const [labels, setLabels] = useState((queryParams.get('labels') || '').split(',').filter(v => v !== ''));
    // internal state
    const [charts, setCharts] = useState<Chart[]>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error>();
    const [darkMode, setDarkMode] = useState(() => document.body.classList.contains('modern-theme-dark'));

    // save history
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        history.push(historyUrl('reports' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {namespace, labels: labels.join(',')}));
    }, [namespace, labels]);

    function onChange(newNamespace: string, newLabels: string[]) {
        setNamespace(newNamespace);
        setLabels(newLabels);
    }

    useEffect(() => {
        const updateTheme = () => setDarkMode(document.body.classList.contains('modern-theme-dark'));
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.body, {attributes: true, attributeFilter: ['class']});
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!namespace) {
            setCharts(null);
            setError(null);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setCharts(undefined);
        setError(null);
        setLoading(true);
        (async () => {
            try {
                const list = await services.workflows.list(namespace, [], labels, {limit}, [
                    'items.metadata.name',
                    'items.metadata.annotations',
                    'items.status.phase',
                    'items.status.startedAt',
                    'items.status.finishedAt',
                    'items.status.resourcesDuration'
                ]);
                const newCharts = workflowsToChartData(list.items || [], limit, darkMode);
                if (!cancelled) {
                    setCharts(newCharts);
                    setError(null);
                }
            } catch (newError) {
                if (!cancelled) {
                    setError(newError);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [namespace, labels.toString(), darkMode]); // referential equality, so use values, not refs

    useCollectEvent('openedReports');

    return (
        <Page
            title='Reports'
            toolbar={{
                breadcrumbs: [
                    {title: 'Reports', path: uiUrl('reports')},
                    {title: namespace, path: uiUrl('reports/' + namespace)}
                ]
            }}>
            <h1 className='modern-visually-hidden'>Workflow reports</h1>
            <div>
                <ReportFilters namespace={namespace} labels={labels} onChange={onChange} />
                <div className='filter-bar__results'>
                    <ErrorNotice error={error} />
                    {loading ? (
                        <p role='status'>Loading workflow report…</p>
                    ) : error ? null : !namespace ? (
                        <ZeroState title='Workflow report'>
                            <p>Select a namespace to view a report.</p>
                        </ZeroState>
                    ) : charts && charts[0].data.labels.length === 0 ? (
                        <ZeroState title='No completed runs'>
                            <p>No completed runs match these filters among the {limit} most recently retrieved runs.</p>
                        </ZeroState>
                    ) : charts ? (
                        <>
                            {charts.map(chart => {
                                const isResourcesChart = chart.data.name === 'resources';
                                const hasData = chart.data.datasets.some(
                                    (dataset: any) => Array.isArray(dataset.data) && dataset.data.some((value: any) => value !== undefined && value !== null)
                                );
                                return (
                                    <section key={chart.data.name} className={`reports-chart-card reports-chart-card--${chart.data.name}`}>
                                        <header className='reports-chart-card__header'>
                                            <div>
                                                <h2>{isResourcesChart ? 'Resource consumption' : 'Workflow duration'}</h2>
                                                <p>
                                                    {isResourcesChart
                                                        ? 'CPU, memory, and storage usage across completed workflows.'
                                                        : 'Compare completed workflow runtimes and spot outliers quickly.'}
                                                </p>
                                            </div>
                                            <span className='reports-chart-card__count'>{chart.data.labels.length} workflows</span>
                                        </header>
                                        <div className='reports-chart-card__body'>
                                            {isResourcesChart && !hasData ? (
                                                <div className='reports-chart-card__empty'>
                                                    <i className='fa fa-chart-area' aria-hidden='true' />
                                                    <strong>No resource duration data</strong>
                                                    <span>Resource metrics are not available for these workflows.</span>
                                                </div>
                                            ) : (
                                                <div
                                                    role='img'
                                                    aria-label={`${isResourcesChart ? 'Resource consumption' : 'Workflow duration'} chart for ${chart.data.labels.length} workflows`}>
                                                    <Bar
                                                        data={chart.data}
                                                        options={chart.options}
                                                        plugins={[roundedHistogramBars]}
                                                        onElementsClick={(e: any[]) => {
                                                            const activePoint = e[0];
                                                            if (activePoint === undefined) {
                                                                return;
                                                            }
                                                            const workflowName = chart.workflowNames[activePoint._index];
                                                            navigation.goto(uiUrl('workflows/' + namespace + '/' + workflowName));
                                                        }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                        <ReportDataTable chart={chart} namespace={namespace} />
                                    </section>
                                );
                            })}
                            <Footnote>
                                <InfoIcon /> {charts[0].data.labels.length} records analyzed.
                            </Footnote>
                        </>
                    ) : null}
                </div>
            </div>
        </Page>
    );
}

function ReportDataTable({chart, namespace}: {chart: Chart; namespace: string}) {
    const isDuration = chart.data.name === 'duration';
    const datasets = chart.data.datasets || [];

    return (
        <details className='reports-chart-card__data'>
            <summary>View report data</summary>
            <div className='reports-chart-card__table-wrapper'>
                <table>
                    <caption className='modern-visually-hidden'>{isDuration ? 'Workflow duration data' : 'Workflow resource consumption data'}</caption>
                    <thead>
                        <tr>
                            <th scope='col'>Workflow</th>
                            {datasets.map((dataset: any, index: number) => (
                                <th scope='col' key={dataset.label || index}>
                                    {isDuration ? 'Duration' : dataset.label || 'Value'}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {chart.workflowNames.map((workflowName: string, rowIndex: number) => {
                            const displayName = chart.fullNames[rowIndex];
                            return (
                                <tr key={workflowName}>
                                    <th scope='row'>
                                        <a href={uiUrl(`workflows/${namespace}/${workflowName}`)} title={workflowName}>
                                            {displayName}
                                        </a>
                                    </th>
                                    {datasets.map((dataset: any, datasetIndex: number) => {
                                        const value = dataset.data?.[rowIndex];
                                        return (
                                            <td key={`${workflowName}-${dataset.label || datasetIndex}`}>
                                                {value == null ? 'Not available' : isDuration ? formatDuration(value) : value}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </details>
    );
}

export default Reports;
