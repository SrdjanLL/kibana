/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SomeDevLog } from '@kbn/some-dev-log';
import type { Client as EsClient } from '@elastic/elasticsearch';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { mean, median, deviation, min, max } from 'd3';
import type { DatasetScoreWithStats } from './evaluation_stats';
import type { EvaluationReport, EvaluationResultDocument } from '../types';
import type { KibanaPhoenixClient } from '../kibana_phoenix_client/client';

// Legacy document type for backward compatibility with existing ES data
export interface EvaluationScoreDocument {
  '@timestamp': string;
  run_id: string;
  experiment_id: string;
  repetitions: number;
  model: {
    id: string;
    family: string;
    provider: string;
  };
  evaluator_model: {
    id: string;
    family: string;
    provider: string;
  };
  dataset: {
    id: string;
    name: string;
    examples_count: number;
  };
  evaluator: {
    name: string;
    stats: {
      mean: number;
      median: number;
      std_dev: number;
      min: number;
      max: number;
      count: number;
      percentage: number;
    };
    scores: number[];
  };
  environment: {
    hostname: string;
  };
}

/**
 * Parses Elasticsearch EvaluationScoreDocuments to DatasetScoreWithStats array
 * This is the core transformation logic shared across different reporters
 */
export function parseScoreDocuments(documents: EvaluationScoreDocument[]): DatasetScoreWithStats[] {
  const datasetMap = new Map<string, DatasetScoreWithStats>();

  for (const doc of documents) {
    if (!datasetMap.has(doc.dataset.id)) {
      datasetMap.set(doc.dataset.id, {
        id: doc.dataset.id,
        name: doc.dataset.name,
        numExamples: doc.dataset.examples_count,
        evaluatorScores: new Map(),
        evaluatorStats: new Map(),
        experimentId: doc.experiment_id,
      });
    }

    const dataset = datasetMap.get(doc.dataset.id)!;

    dataset.evaluatorScores.set(doc.evaluator.name, doc.evaluator.scores);
    dataset.evaluatorStats.set(doc.evaluator.name, {
      mean: doc.evaluator.stats.mean,
      median: doc.evaluator.stats.median,
      stdDev: doc.evaluator.stats.std_dev,
      min: doc.evaluator.stats.min,
      max: doc.evaluator.stats.max,
      count: doc.evaluator.stats.count,
      percentage: doc.evaluator.stats.percentage,
    });
  }

  return Array.from(datasetMap.values());
}

/**
 * Parse flattened EvaluationResultDocuments back to DatasetScoreWithStats format
 * for backward compatibility with terminal reporter
 */
export function parseFlattenedDocuments(
  documents: EvaluationResultDocument[]
): DatasetScoreWithStats[] {
  const datasetMap = new Map<
    string,
    {
      id: string;
      name: string;
      experimentId: string;
      exampleIds: Set<string>;
      evaluatorScores: Map<string, number[]>;
    }
  >();

  for (const doc of documents) {
    const datasetId = doc.dataset.id;

    if (!datasetMap.has(datasetId)) {
      datasetMap.set(datasetId, {
        id: datasetId,
        name: doc.dataset.name,
        experimentId: doc.experiment_id,
        exampleIds: new Set(),
        evaluatorScores: new Map(),
      });
    }

    const dataset = datasetMap.get(datasetId)!;
    dataset.exampleIds.add(doc.example.id);

    if (!dataset.evaluatorScores.has(doc.evaluator.name)) {
      dataset.evaluatorScores.set(doc.evaluator.name, []);
    }
    dataset.evaluatorScores.get(doc.evaluator.name)!.push(doc.evaluation.score);
  }

  return Array.from(datasetMap.values()).map((dataset) => {
    const evaluatorStats = new Map<
      string,
      {
        mean: number;
        median: number;
        stdDev: number;
        min: number;
        max: number;
        count: number;
        percentage: number;
      }
    >();

    const numExamples = dataset.exampleIds.size;

    for (const [evaluatorName, scores] of dataset.evaluatorScores.entries()) {
      const totalScore = scores.reduce((sum, s) => sum + s, 0);
      evaluatorStats.set(evaluatorName, {
        mean: mean(scores) ?? 0,
        median: median(scores) ?? 0,
        stdDev: deviation(scores) ?? 0,
        min: min(scores) ?? 0,
        max: max(scores) ?? 0,
        count: scores.length,
        percentage: numExamples > 0 ? totalScore / numExamples : 0,
      });
    }

    return {
      id: dataset.id,
      name: dataset.name,
      numExamples,
      evaluatorScores: dataset.evaluatorScores,
      evaluatorStats,
      experimentId: dataset.experimentId,
    };
  });
}

const EVALUATIONS_DATA_STREAM_ALIAS = '.kibana-evaluations';
const EVALUATIONS_DATA_STREAM_WILDCARD = '.kibana-evaluations*';
const EVALUATIONS_DATA_STREAM_TEMPLATE = 'kibana-evaluations-template';

export class EvaluationScoreRepository {
  constructor(private readonly esClient: EsClient, private readonly log: SomeDevLog) {}

  private async ensureIndexTemplate(): Promise<void> {
    const templateBody = {
      index_patterns: [EVALUATIONS_DATA_STREAM_WILDCARD],
      data_stream: {
        hidden: true,
      },
      template: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          refresh_interval: '5s',
          'index.hidden': true,
        },
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            run_id: { type: 'keyword' },
            experiment_id: { type: 'keyword' },
            repetition: { type: 'integer' },
            model: {
              type: 'object',
              properties: {
                id: { type: 'keyword' },
                family: { type: 'keyword' },
                provider: { type: 'keyword' },
              },
            },
            evaluator_model: {
              type: 'object',
              properties: {
                id: { type: 'keyword' },
                family: { type: 'keyword' },
                provider: { type: 'keyword' },
              },
            },
            dataset: {
              type: 'object',
              properties: {
                id: { type: 'keyword' },
                name: { type: 'keyword' },
              },
            },
            example: {
              type: 'object',
              properties: {
                id: { type: 'keyword' },
                input_hash: { type: 'keyword' },
                metadata: { type: 'flattened' },
              },
            },
            evaluator: {
              type: 'object',
              properties: {
                name: { type: 'keyword' },
                kind: { type: 'keyword' },
              },
            },
            evaluation: {
              type: 'object',
              properties: {
                score: { type: 'float' },
                label: { type: 'keyword' },
                explanation: { type: 'text' },
                error: { type: 'text' },
              },
            },
            timing: {
              type: 'object',
              properties: {
                task_start: { type: 'date' },
                task_end: { type: 'date' },
                evaluation_start: { type: 'date' },
                evaluation_end: { type: 'date' },
              },
            },
            trace: {
              type: 'object',
              properties: {
                task_trace_id: { type: 'keyword' },
                evaluation_trace_id: { type: 'keyword' },
              },
            },
            environment: {
              type: 'object',
              properties: {
                hostname: { type: 'keyword' },
              },
            },
          },
        },
      },
    };

    try {
      const templateExists = await this.esClient.indices
        .existsIndexTemplate({
          name: EVALUATIONS_DATA_STREAM_TEMPLATE,
        })
        .catch(() => false);

      if (!templateExists) {
        await this.esClient.indices.putIndexTemplate({
          name: EVALUATIONS_DATA_STREAM_TEMPLATE,
          index_patterns: templateBody.index_patterns,
          data_stream: templateBody.data_stream,
          template: templateBody.template as any,
        });

        this.log.debug('Created Elasticsearch index template for evaluation scores');
      }
    } catch (error) {
      this.log.error('Failed to create index template:', error);
      throw error;
    }
  }

  private async ensureDatastream(): Promise<void> {
    try {
      await this.esClient.indices.getDataStream({
        name: EVALUATIONS_DATA_STREAM_ALIAS,
      });
    } catch (error: any) {
      if (error?.statusCode === 404) {
        await this.esClient.indices.createDataStream({
          name: EVALUATIONS_DATA_STREAM_ALIAS,
        });
        this.log.debug(`Created datastream: ${EVALUATIONS_DATA_STREAM_ALIAS}`);
      } else {
        throw error;
      }
    }
  }

  private hashInput(input: unknown): string {
    const jsonStr = JSON.stringify(input ?? {});
    return createHash('sha256').update(jsonStr).digest('hex').substring(0, 16);
  }

  async exportScores(report: EvaluationReport, phoenixClient: KibanaPhoenixClient): Promise<void> {
    try {
      await this.ensureIndexTemplate();
      await this.ensureDatastream();

      const { experiments, model, evaluatorModel, runId } = report;

      if (experiments.length === 0) {
        this.log.warning('No experiments found to export');
        return;
      }

      const documents: EvaluationResultDocument[] = [];
      const timestamp = new Date().toISOString();
      const hostName = hostname();

      // Fetch dataset info for all experiments
      const datasetIds = [...new Set(experiments.map((exp) => exp.datasetId))];
      const datasetInfos = await phoenixClient.getDatasets(datasetIds);
      const datasetInfoById = new Map(datasetInfos.map((d) => [d.id, d]));

      // Fetch examples for all datasets
      const examplesByDataset = new Map<string, Map<string, any>>();
      for (const datasetId of datasetIds) {
        const examples = await phoenixClient.getDatasetExamples(datasetId);
        examplesByDataset.set(datasetId, examples);
      }

      for (const experiment of experiments) {
        const { datasetId, evaluationRuns, runs, id: experimentId } = experiment;
        const datasetInfo = datasetInfoById.get(datasetId);
        const datasetExamples = examplesByDataset.get(datasetId) ?? new Map();

        if (!evaluationRuns || !runs) {
          continue;
        }

        // Build a map from experimentRunId to the ExperimentRun
        const runsById = new Map(Object.entries(runs));

        // Track repetition number for each (exampleId, evaluatorName) pair
        const repetitionTracker = new Map<string, number>();

        for (const evalRun of evaluationRuns) {
          const experimentRun = runsById.get(evalRun.experimentRunId);
          if (!experimentRun) {
            continue;
          }

          const exampleId = experimentRun.datasetExampleId;
          const example = datasetExamples.get(exampleId);

          // Track repetition for this (example, evaluator) pair
          const repetitionKey = `${exampleId}:${evalRun.name}`;
          const currentRepetition = (repetitionTracker.get(repetitionKey) ?? 0) + 1;
          repetitionTracker.set(repetitionKey, currentRepetition);

          const document: EvaluationResultDocument = {
            '@timestamp': timestamp,
            run_id: runId,
            experiment_id: experimentId ?? '',
            repetition: currentRepetition,
            model: {
              id: model.id || 'unknown',
              family: model.family,
              provider: model.provider,
            },
            evaluator_model: {
              id: evaluatorModel.id || 'unknown',
              family: evaluatorModel.family,
              provider: evaluatorModel.provider,
            },
            dataset: {
              id: datasetId,
              name: datasetInfo?.name ?? datasetId,
            },
            example: {
              id: exampleId,
              input_hash: this.hashInput(example?.input),
              metadata: example?.metadata ?? {},
            },
            evaluator: {
              name: evalRun.name,
              kind: evalRun.annotatorKind ?? 'LLM',
            },
            evaluation: {
              score: evalRun.result?.score ?? 0,
              label: evalRun.result?.label ?? null,
              explanation: evalRun.result?.explanation ?? null,
              error: evalRun.error ?? null,
            },
            timing: {
              task_start: experimentRun.startTime?.toISOString() ?? null,
              task_end: experimentRun.endTime?.toISOString() ?? null,
              evaluation_start: evalRun.startTime?.toISOString() ?? null,
              evaluation_end: evalRun.endTime?.toISOString() ?? null,
            },
            trace: {
              task_trace_id: experimentRun.traceId ?? null,
              evaluation_trace_id: evalRun.traceId ?? null,
            },
            environment: {
              hostname: hostName,
            },
          };

          documents.push(document);
        }
      }

      if (documents.length > 0) {
        const stats = await this.esClient.helpers.bulk({
          datasource: documents,
          onDocument: (doc) => {
            const docId = `${doc.run_id}-${doc.dataset.id}-${doc.example.id}-${doc.evaluator.name}-${doc.repetition}`;
            return {
              create: {
                _index: EVALUATIONS_DATA_STREAM_ALIAS,
                _id: docId,
              },
            };
          },
          refresh: 'wait_for',
        });

        if (stats.failed > 0) {
          this.log.error(
            `Bulk indexing had ${stats.failed} failed operations out of ${stats.total}`
          );
          throw new Error(
            `Bulk indexing failed: ${stats.failed} of ${stats.total} operations failed`
          );
        }

        this.log.debug(
          `Successfully indexed ${documents.length} flattened evaluation results to datastream: ${EVALUATIONS_DATA_STREAM_ALIAS}`
        );
      }
    } catch (error) {
      this.log.error('Failed to export scores to Elasticsearch:', error);
      throw error;
    }
  }

  async getScoresByRunId(runId: string): Promise<EvaluationScoreDocument[]> {
    try {
      // Query flattened documents and aggregate them back to the legacy format
      const response = await this.esClient.search<EvaluationResultDocument>({
        index: EVALUATIONS_DATA_STREAM_WILDCARD,
        query: {
          bool: {
            must: [{ term: { run_id: runId } }],
          },
        },
        sort: [
          { 'dataset.name': { order: 'asc' as const } },
          { 'evaluator.name': { order: 'asc' as const } },
        ],
        size: 10000,
      });

      const hits = response.hits?.hits || [];
      const flatDocs = hits
        .map((hit) => hit._source)
        .filter((source): source is EvaluationResultDocument => source !== undefined);

      if (flatDocs.length === 0) {
        this.log.info(`No scores found for run ID: ${runId}`);
        return [];
      }

      // Group by (dataset, evaluator) to reconstruct EvaluationScoreDocument format
      const groupedDocs = new Map<
        string,
        {
          docs: EvaluationResultDocument[];
          exampleIds: Set<string>;
        }
      >();

      for (const doc of flatDocs) {
        const key = `${doc.dataset.id}:${doc.evaluator.name}`;
        if (!groupedDocs.has(key)) {
          groupedDocs.set(key, { docs: [], exampleIds: new Set() });
        }
        groupedDocs.get(key)!.docs.push(doc);
        groupedDocs.get(key)!.exampleIds.add(doc.example.id);
      }

      // Convert to legacy EvaluationScoreDocument format
      const legacyDocs: EvaluationScoreDocument[] = [];

      for (const [, { docs, exampleIds }] of groupedDocs) {
        const firstDoc = docs[0];
        const scores = docs.map((d) => d.evaluation.score);
        const numExamples = exampleIds.size;
        const totalScore = scores.reduce((sum, s) => sum + s, 0);

        // Find max repetition to determine repetitions count
        const maxRepetition = Math.max(...docs.map((d) => d.repetition));

        legacyDocs.push({
          '@timestamp': firstDoc['@timestamp'],
          run_id: firstDoc.run_id,
          experiment_id: firstDoc.experiment_id,
          repetitions: maxRepetition,
          model: firstDoc.model,
          evaluator_model: firstDoc.evaluator_model,
          dataset: {
            id: firstDoc.dataset.id,
            name: firstDoc.dataset.name,
            examples_count: numExamples,
          },
          evaluator: {
            name: firstDoc.evaluator.name,
            stats: {
              mean: mean(scores) ?? 0,
              median: median(scores) ?? 0,
              std_dev: deviation(scores) ?? 0,
              min: min(scores) ?? 0,
              max: max(scores) ?? 0,
              count: scores.length,
              percentage: numExamples > 0 ? totalScore / numExamples : 0,
            },
            scores,
          },
          environment: firstDoc.environment,
        });
      }

      this.log.info(`Retrieved ${legacyDocs.length} aggregated scores for run ID: ${runId}`);
      return legacyDocs;
    } catch (error) {
      this.log.error(`Failed to retrieve scores for run ID ${runId}:`, error);
      return [];
    }
  }
}
