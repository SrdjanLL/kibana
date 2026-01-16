/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  parseScoreDocuments,
  EvaluationScoreRepository,
  type EvaluationScoreDocument,
} from './score_repository';
import type { Model } from '@kbn/inference-common';
import { ModelFamily, ModelProvider } from '@kbn/inference-common';
import type { SomeDevLog } from '@kbn/some-dev-log';
import type { EvaluationReport } from '../types';
import type { KibanaPhoenixClient } from '../kibana_phoenix_client/client';
import type { RanExperiment } from '@arizeai/phoenix-client/dist/esm/types/experiments';

describe('parseScoreDocuments', () => {
  const baseModel = {
    id: 'gpt-4',
    family: ModelFamily.GPT,
    provider: ModelProvider.OpenAI,
  };

  const baseEvaluatorModel = {
    id: 'claude-3',
    family: ModelFamily.Claude,
    provider: ModelProvider.Anthropic,
  };

  const createMockScoreDocument = (
    overrides: Partial<EvaluationScoreDocument> = {}
  ): EvaluationScoreDocument => ({
    '@timestamp': '2025-01-01T00:00:00Z',
    run_id: 'run-123',
    experiment_id: 'exp-1',
    repetitions: 1,
    model: baseModel,
    evaluator_model: baseEvaluatorModel,
    dataset: {
      id: 'dataset-1',
      name: 'Test Dataset',
      examples_count: 10,
    },
    evaluator: {
      name: 'Correctness',
      stats: {
        mean: 0.85,
        median: 0.9,
        std_dev: 0.1,
        min: 0.6,
        max: 1.0,
        count: 10,
        percentage: 0.85,
      },
      scores: [0.8, 0.9, 0.85, 0.75, 0.95, 1.0, 0.6, 0.9, 0.85, 0.9],
    },
    environment: {
      hostname: 'test-machine',
    },
    ...overrides,
  });

  it('should parse a single document into a dataset score', () => {
    const docs = [createMockScoreDocument()];
    const result = parseScoreDocuments(docs);

    expect(result).toHaveLength(1);
    const dataset = result[0];

    expect(dataset.id).toBe('dataset-1');
    expect(dataset.name).toBe('Test Dataset');
    expect(dataset.numExamples).toBe(10);
    expect(dataset.experimentId).toBe('exp-1');
    expect(dataset.evaluatorScores.get('Correctness')).toEqual([
      0.8, 0.9, 0.85, 0.75, 0.95, 1.0, 0.6, 0.9, 0.85, 0.9,
    ]);
  });

  it('should group multiple evaluators for the same dataset', () => {
    const docs = [
      createMockScoreDocument({
        evaluator: {
          name: 'Correctness',
          stats: {
            mean: 0.85,
            median: 0.9,
            std_dev: 0.1,
            min: 0.6,
            max: 1.0,
            count: 10,
            percentage: 0.85,
          },
          scores: [0.8, 0.9, 0.85],
        },
      }),
      createMockScoreDocument({
        evaluator: {
          name: 'Groundedness',
          stats: {
            mean: 0.75,
            median: 0.8,
            std_dev: 0.15,
            min: 0.5,
            max: 0.95,
            count: 10,
            percentage: 0.75,
          },
          scores: [0.7, 0.8, 0.75],
        },
      }),
    ];

    const result = parseScoreDocuments(docs);

    expect(result).toHaveLength(1);
    const dataset = result[0];

    expect(dataset.evaluatorScores.size).toBe(2);
    expect(dataset.evaluatorScores.get('Correctness')).toEqual([0.8, 0.9, 0.85]);
    expect(dataset.evaluatorScores.get('Groundedness')).toEqual([0.7, 0.8, 0.75]);

    expect(dataset.evaluatorStats.size).toBe(2);
    expect(dataset.evaluatorStats.get('Correctness')).toMatchObject({
      mean: 0.85,
      median: 0.9,
      stdDev: 0.1,
      min: 0.6,
      max: 1.0,
      count: 10,
      percentage: 0.85,
    });
    expect(dataset.evaluatorStats.get('Groundedness')).toMatchObject({
      mean: 0.75,
      median: 0.8,
      stdDev: 0.15,
      min: 0.5,
      max: 0.95,
      count: 10,
      percentage: 0.75,
    });
  });

  it('should separate documents for different datasets', () => {
    const docs = [
      createMockScoreDocument({
        dataset: { id: 'dataset-1', name: 'Dataset 1', examples_count: 10 },
        experiment_id: 'exp-1',
        evaluator: {
          name: 'Correctness',
          stats: {
            mean: 0.85,
            median: 0.9,
            std_dev: 0.1,
            min: 0.6,
            max: 1.0,
            count: 10,
            percentage: 0.85,
          },
          scores: [0.8, 0.9],
        },
      }),
      createMockScoreDocument({
        dataset: { id: 'dataset-2', name: 'Dataset 2', examples_count: 5 },
        experiment_id: 'exp-2',
        evaluator: {
          name: 'Correctness',
          stats: {
            mean: 0.75,
            median: 0.8,
            std_dev: 0.15,
            min: 0.5,
            max: 0.95,
            count: 5,
            percentage: 0.75,
          },
          scores: [0.7, 0.8],
        },
      }),
    ];

    const result = parseScoreDocuments(docs);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('dataset-1');
    expect(result[0].name).toBe('Dataset 1');
    expect(result[0].experimentId).toBe('exp-1');
    expect(result[1].id).toBe('dataset-2');
    expect(result[1].name).toBe('Dataset 2');
    expect(result[1].experimentId).toBe('exp-2');
  });
});

describe('EvaluationScoreRepository', () => {
  let mockEsClient: any;
  let mockLog: jest.Mocked<SomeDevLog>;
  let mockPhoenixClient: jest.Mocked<KibanaPhoenixClient>;
  let repository: EvaluationScoreRepository;

  const mockModel: Model = {
    id: 'gpt-4',
    family: ModelFamily.GPT,
    provider: ModelProvider.OpenAI,
  };

  const mockEvaluatorModel: Model = {
    id: 'claude-3',
    family: ModelFamily.Claude,
    provider: ModelProvider.Anthropic,
  };

  const createMockExperiment = (): RanExperiment => ({
    id: 'exp-1',
    datasetId: 'dataset-1',
    datasetVersionId: 'version-1',
    projectName: 'test-project',
    metadata: {},
    runs: {
      'run-1': {
        id: 'run-1',
        experimentId: 'exp-1',
        datasetExampleId: 'example-1',
        startTime: new Date('2025-01-01T00:00:00Z'),
        endTime: new Date('2025-01-01T00:00:01Z'),
        output: 'test output',
        error: null,
        traceId: 'trace-task-1',
      },
      'run-2': {
        id: 'run-2',
        experimentId: 'exp-1',
        datasetExampleId: 'example-2',
        startTime: new Date('2025-01-01T00:00:02Z'),
        endTime: new Date('2025-01-01T00:00:03Z'),
        output: 'test output 2',
        error: null,
        traceId: 'trace-task-2',
      },
    },
    evaluationRuns: [
      {
        id: 'eval-1',
        experimentRunId: 'run-1',
        name: 'Correctness',
        annotatorKind: 'LLM',
        startTime: new Date('2025-01-01T00:00:01Z'),
        endTime: new Date('2025-01-01T00:00:02Z'),
        result: { score: 0.8, label: 'correct', explanation: 'Good response' },
        error: null,
        traceId: 'trace-eval-1',
      },
      {
        id: 'eval-2',
        experimentRunId: 'run-2',
        name: 'Correctness',
        annotatorKind: 'LLM',
        startTime: new Date('2025-01-01T00:00:03Z'),
        endTime: new Date('2025-01-01T00:00:04Z'),
        result: { score: 0.9, label: 'correct', explanation: 'Excellent response' },
        error: null,
        traceId: 'trace-eval-2',
      },
    ],
  });

  const createMockReport = (experiments: RanExperiment[] = []): EvaluationReport => ({
    datasetScoresWithStats: [],
    model: mockModel,
    evaluatorModel: mockEvaluatorModel,
    repetitions: 1,
    runId: 'run-123',
    experiments,
  });

  beforeEach(() => {
    mockEsClient = {
      indices: {
        existsIndexTemplate: jest.fn(),
        putIndexTemplate: jest.fn(),
        getDataStream: jest.fn(),
        createDataStream: jest.fn(),
      },
      helpers: {
        bulk: jest.fn(),
      },
      search: jest.fn(),
    };

    mockLog = {
      debug: jest.fn(),
      info: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
    } as any;

    mockPhoenixClient = {
      getDatasets: jest.fn().mockResolvedValue([{ id: 'dataset-1', name: 'Test Dataset' }]),
      getDatasetExamples: jest.fn().mockResolvedValue(
        new Map([
          ['example-1', { id: 'example-1', input: { query: 'test 1' }, metadata: { type: 'qa' } }],
          ['example-2', { id: 'example-2', input: { query: 'test 2' }, metadata: { type: 'qa' } }],
        ])
      ),
    } as any;

    repository = new EvaluationScoreRepository(mockEsClient, mockLog);
  });

  describe('exportScores', () => {
    it('should successfully export flattened scores when index template and datastream exist', async () => {
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(true as any);
      mockEsClient.indices.getDataStream.mockResolvedValue({} as any);
      mockEsClient.helpers.bulk.mockResolvedValue({
        total: 2,
        failed: 0,
        successful: 2,
      } as any);

      const report = createMockReport([createMockExperiment()]);
      await repository.exportScores(report, mockPhoenixClient);

      expect(mockEsClient.indices.existsIndexTemplate).toHaveBeenCalled();
      expect(mockEsClient.indices.getDataStream).toHaveBeenCalled();
      expect(mockEsClient.helpers.bulk).toHaveBeenCalledWith(
        expect.objectContaining({
          datasource: expect.arrayContaining([
            expect.objectContaining({
              run_id: 'run-123',
              experiment_id: 'exp-1',
              repetition: 1,
              model: mockModel,
              evaluator_model: mockEvaluatorModel,
              dataset: {
                id: 'dataset-1',
                name: 'Test Dataset',
              },
              example: expect.objectContaining({
                id: 'example-1',
              }),
              evaluator: {
                name: 'Correctness',
                kind: 'LLM',
              },
              evaluation: expect.objectContaining({
                score: 0.8,
              }),
            }),
          ]),
          refresh: 'wait_for',
        })
      );
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.stringContaining('Successfully indexed 2 flattened evaluation results')
      );
    });

    it('should create index template if it does not exist', async () => {
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(false as any);
      mockEsClient.indices.putIndexTemplate.mockResolvedValue({} as any);
      mockEsClient.indices.getDataStream.mockResolvedValue({} as any);
      mockEsClient.helpers.bulk.mockResolvedValue({
        total: 2,
        failed: 0,
        successful: 2,
      } as any);

      const report = createMockReport([createMockExperiment()]);
      await repository.exportScores(report, mockPhoenixClient);

      expect(mockEsClient.indices.putIndexTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'kibana-evaluations-template',
          index_patterns: ['.kibana-evaluations*'],
        })
      );
      expect(mockLog.debug).toHaveBeenCalledWith(
        'Created Elasticsearch index template for evaluation scores'
      );
    });

    it('should create datastream if it does not exist', async () => {
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(true as any);
      mockEsClient.indices.getDataStream.mockRejectedValue({ statusCode: 404 });
      mockEsClient.indices.createDataStream.mockResolvedValue({} as any);
      mockEsClient.helpers.bulk.mockResolvedValue({
        total: 2,
        failed: 0,
        successful: 2,
      } as any);

      const report = createMockReport([createMockExperiment()]);
      await repository.exportScores(report, mockPhoenixClient);

      expect(mockEsClient.indices.createDataStream).toHaveBeenCalledWith({
        name: '.kibana-evaluations',
      });
      expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('Created datastream'));
    });

    it('should handle empty experiments', async () => {
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(true as any);
      mockEsClient.indices.getDataStream.mockResolvedValue({} as any);

      const report = createMockReport([]);
      await repository.exportScores(report, mockPhoenixClient);

      expect(mockLog.warning).toHaveBeenCalledWith('No experiments found to export');
      expect(mockEsClient.helpers.bulk).not.toHaveBeenCalled();
    });

    it('should throw error if bulk indexing fails', async () => {
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(true as any);
      mockEsClient.indices.getDataStream.mockResolvedValue({} as any);
      mockEsClient.helpers.bulk.mockResolvedValue({
        total: 2,
        failed: 2,
        successful: 0,
      } as any);

      const report = createMockReport([createMockExperiment()]);
      await expect(repository.exportScores(report, mockPhoenixClient)).rejects.toThrow(
        'Bulk indexing failed: 2 of 2 operations failed'
      );

      expect(mockLog.error).toHaveBeenCalledWith('Bulk indexing had 2 failed operations out of 2');
    });

    it('should handle index template creation errors', async () => {
      const error = new Error('Template creation failed');
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(false as any);
      mockEsClient.indices.putIndexTemplate.mockRejectedValue(error);

      const report = createMockReport([createMockExperiment()]);
      await expect(repository.exportScores(report, mockPhoenixClient)).rejects.toThrow(
        'Template creation failed'
      );

      expect(mockLog.error).toHaveBeenCalledWith('Failed to create index template:', error);
    });

    it('should handle datastream creation errors', async () => {
      const error = new Error('Datastream creation failed');
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(true as any);
      mockEsClient.indices.getDataStream.mockRejectedValue({ statusCode: 404 });
      mockEsClient.indices.createDataStream.mockRejectedValue(error);

      const report = createMockReport([createMockExperiment()]);
      await expect(repository.exportScores(report, mockPhoenixClient)).rejects.toThrow(
        'Datastream creation failed'
      );

      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to export scores to Elasticsearch:',
        error
      );
    });

    it('should export separate documents for each evaluation', async () => {
      mockEsClient.indices.existsIndexTemplate.mockResolvedValue(true as any);
      mockEsClient.indices.getDataStream.mockResolvedValue({} as any);
      mockEsClient.helpers.bulk.mockResolvedValue({
        total: 2,
        failed: 0,
        successful: 2,
      } as any);

      const report = createMockReport([createMockExperiment()]);
      await repository.exportScores(report, mockPhoenixClient);

      const bulkCall = mockEsClient.helpers.bulk.mock.calls[0][0];
      expect(bulkCall.datasource).toHaveLength(2);
      expect(bulkCall.datasource[0].example.id).toBe('example-1');
      expect(bulkCall.datasource[0].evaluation.score).toBe(0.8);
      expect(bulkCall.datasource[1].example.id).toBe('example-2');
      expect(bulkCall.datasource[1].evaluation.score).toBe(0.9);
    });
  });

  describe('getScoresByRunId', () => {
    it('should retrieve and aggregate flattened scores into legacy format', async () => {
      const flattenedDocs = [
        {
          '@timestamp': '2025-01-01T00:00:00Z',
          run_id: 'run-123',
          experiment_id: 'exp-1',
          repetition: 1,
          model: mockModel,
          evaluator_model: mockEvaluatorModel,
          dataset: { id: 'dataset-1', name: 'Test Dataset' },
          example: { id: 'example-1', input_hash: 'abc123', metadata: {} },
          evaluator: { name: 'Correctness', kind: 'LLM' },
          evaluation: { score: 0.8, label: 'correct', explanation: 'Good', error: null },
          timing: {
            task_start: null,
            task_end: null,
            evaluation_start: null,
            evaluation_end: null,
          },
          trace: { task_trace_id: null, evaluation_trace_id: null },
          environment: { hostname: 'test-machine' },
        },
        {
          '@timestamp': '2025-01-01T00:00:00Z',
          run_id: 'run-123',
          experiment_id: 'exp-1',
          repetition: 1,
          model: mockModel,
          evaluator_model: mockEvaluatorModel,
          dataset: { id: 'dataset-1', name: 'Test Dataset' },
          example: { id: 'example-2', input_hash: 'def456', metadata: {} },
          evaluator: { name: 'Correctness', kind: 'LLM' },
          evaluation: { score: 0.9, label: 'correct', explanation: 'Great', error: null },
          timing: {
            task_start: null,
            task_end: null,
            evaluation_start: null,
            evaluation_end: null,
          },
          trace: { task_trace_id: null, evaluation_trace_id: null },
          environment: { hostname: 'test-machine' },
        },
      ];

      mockEsClient.search.mockResolvedValue({
        hits: {
          hits: flattenedDocs.map((doc) => ({ _source: doc })),
        },
      } as any);

      const result = await repository.getScoresByRunId('run-123');

      expect(result).toHaveLength(1);
      expect(result[0].dataset.id).toBe('dataset-1');
      expect(result[0].evaluator.name).toBe('Correctness');
      expect(result[0].evaluator.scores).toEqual([0.8, 0.9]);
      expect(result[0].evaluator.stats.count).toBe(2);
      expect(mockEsClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: '.kibana-evaluations*',
          query: {
            bool: {
              must: [{ term: { run_id: 'run-123' } }],
            },
          },
        })
      );
      expect(mockLog.info).toHaveBeenCalledWith(
        'Retrieved 1 aggregated scores for run ID: run-123'
      );
    });

    it('should return empty array when no scores found', async () => {
      mockEsClient.search.mockResolvedValue({
        hits: {
          hits: [],
        },
      } as any);

      const result = await repository.getScoresByRunId('non-existent-run');

      expect(result).toEqual([]);
      expect(mockLog.info).toHaveBeenCalledWith('No scores found for run ID: non-existent-run');
    });

    it('should handle search errors gracefully', async () => {
      const error = new Error('Search failed');
      mockEsClient.search.mockRejectedValue(error);

      const result = await repository.getScoresByRunId('run-123');

      expect(result).toEqual([]);
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to retrieve scores for run ID run-123:',
        error
      );
    });
  });
});
