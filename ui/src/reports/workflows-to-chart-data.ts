import {ANNOTATION_TITLE} from '../shared/annotations';
import {denominator, formatDuration} from '../shared/duration';
import {getColorForNodePhase, Workflow} from '../shared/models';

export function workflowsToChartData(workflows: Workflow[], limit: number, darkMode = false) {
    const filteredWorkflows = workflows
        .filter(wf => !!wf.status.finishedAt && !!wf.status.startedAt)
        .map(wf => ({
            name: wf.metadata.name,
            displayName: wf.metadata.annotations?.[ANNOTATION_TITLE] || wf.metadata.name,
            finishedAt: new Date(wf.status.finishedAt),
            startedAt: new Date(wf.status.startedAt),
            phase: wf.status.phase,
            resourcesDuration: wf.status.resourcesDuration
        }))
        .filter(wf => Number.isFinite(wf.finishedAt.getTime()) && Number.isFinite(wf.startedAt.getTime()) && wf.finishedAt.getTime() > wf.startedAt.getTime())
        .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())
        .slice(0, limit)
        .reverse();

    const labels: string[] = new Array(filteredWorkflows.length);
    const backgroundColors: string[] = new Array(filteredWorkflows.length);
    const durationData: number[] = new Array(filteredWorkflows.length);
    const resourceData = {} as any;

    filteredWorkflows.forEach((wf, i) => {
        labels[i] = wf.displayName;
        backgroundColors[i] = getColorForNodePhase(wf.phase);
        durationData[i] = (wf.finishedAt.getTime() - wf.startedAt.getTime()) / 1000;
        Object.entries(wf.resourcesDuration || {}).forEach(([resource, value]) => {
            if (!resourceData[resource]) {
                resourceData[resource] = new Array(filteredWorkflows.length);
            }
            resourceData[resource][i] = value;
        });
    });
    const resourceColors = {
        'cpu': '#14b8a6',
        'memory': '#3b82f6',
        'storage': '#8b5cf6',
        'ephemeral-storage': '#a855f7'
    } as any;
    const textColor = darkMode ? '#dbeafe' : '#52606d';
    const gridColor = darkMode ? 'rgba(148, 163, 184, 0.18)' : 'rgba(100, 116, 139, 0.14)';
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
            duration: 450,
            easing: 'easeOutQuart'
        },
        layout: {
            padding: {
                top: 12,
                right: 14,
                bottom: 8,
                left: 8
            }
        },
        interaction: {
            mode: 'index',
            intersect: false
        },
        hover: {
            mode: 'index',
            intersect: false
        },
        tooltips: {
            mode: 'index',
            intersect: false,
            backgroundColor: darkMode ? '#0f172a' : '#1e293b',
            titleFontColor: '#f8fafc',
            bodyFontColor: '#e2e8f0',
            borderColor: darkMode ? '#475569' : '#334155',
            borderWidth: 1,
            displayColors: true,
            xPadding: 12,
            yPadding: 10,
            cornerRadius: 8
        },
        scales: {
            xAxes: [
                {
                    gridLines: {display: false},
                    ticks: {
                        fontColor: textColor,
                        maxRotation: 35,
                        minRotation: 0,
                        autoSkip: true,
                        padding: 8
                    }
                }
            ]
        }
    } as any;

    const workflowNames = filteredWorkflows.map(wf => wf.name);
    const fullNames = filteredWorkflows.map(wf => wf.displayName);

    return [
        {
            workflowNames,
            fullNames,
            data: {
                name: 'duration',
                labels,
                datasets: [
                    {
                        data: durationData,
                        backgroundColor: backgroundColors,
                        borderColor: backgroundColors,
                        borderWidth: 0,
                        hoverBackgroundColor: backgroundColors,
                        barPercentage: 0.72,
                        categoryPercentage: 0.82,
                        borderSkipped: false
                    }
                ]
            },
            options: {
                ...chartOptions,
                legend: {display: false},
                scales: {
                    ...chartOptions.scales,
                    yAxes: [
                        {
                            id: 'duration',
                            gridLines: {color: gridColor, zeroLineColor: gridColor},
                            ticks: {
                                beginAtZero: true,
                                fontColor: textColor,
                                padding: 8,
                                callback: (value: number) => formatDuration(value)
                            },
                            scaleLabel: {
                                display: true,
                                labelString: 'Duration',
                                fontColor: textColor
                            }
                        }
                    ]
                },
                tooltips: {
                    ...chartOptions.tooltips,
                    callbacks: {
                        label: (tooltipItem: any) => `Duration: ${formatDuration(Number(tooltipItem.yLabel || 0))}`
                    }
                },
                annotation: {
                    annotations: [
                        {
                            type: 'line',
                            mode: 'horizontal',
                            scaleID: 'duration',
                            value: durationData.length > 0 ? durationData.reduce((a, b) => a + b, 0) / durationData.length : 0,
                            borderColor: darkMode ? '#67e8f9' : '#0f766e',
                            borderWidth: 2,
                            borderDash: [6, 5],
                            label: {
                                enabled: true,
                                position: 'left',
                                content: 'Average',
                                backgroundColor: darkMode ? '#164e63' : '#ccfbf1',
                                fontColor: darkMode ? '#cffafe' : '#115e59',
                                padding: 6,
                                cornerRadius: 5
                            }
                        }
                    ]
                }
            }
        },
        {
            workflowNames,
            fullNames,
            data: {
                name: 'resources',
                labels,
                datasets: Object.entries(resourceData).map(([resource, data]) => ({
                    yAxisID: resource,
                    label: resource,
                    data,
                    backgroundColor: resourceColors[resource] || '#64748b',
                    borderColor: resourceColors[resource] || '#64748b',
                    borderWidth: 0,
                    barPercentage: 0.72,
                    categoryPercentage: 0.82,
                    borderSkipped: false
                }))
            },
            options: {
                ...chartOptions,
                legend: {
                    display: Object.keys(resourceData).length > 1,
                    labels: {fontColor: textColor, padding: 16}
                },
                scales: {
                    ...chartOptions.scales,
                    yAxes: Object.keys(resourceData).map(resource => ({
                        id: resource,
                        gridLines: {color: gridColor, zeroLineColor: gridColor},
                        ticks: {
                            beginAtZero: true,
                            fontColor: textColor,
                            padding: 8
                        },
                        scaleLabel: {
                            display: true,
                            labelString: resource + ' (' + denominator(resource) + ')',
                            fontColor: textColor
                        }
                    }))
                }
            }
        }
    ];
}
