/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { fileDownloadInfo } from '@huggingface/hub';
import { Logger } from '@kbn/core/server';
import streamWeb from 'stream/web';
import { Readable } from 'stream';
import { createGunzip } from 'zlib';
import * as readline from 'node:readline';
import { pickBy } from 'lodash';
import { format } from 'util';
import { HuggingFaceDatasetSpec } from './types';

function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + 'mb';
}

/**
 * Simple CSV parser that handles quoted fields and escaping
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i += 2;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      result.push(current.trim());
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Converts CSV data to JSON objects
 */
function csvToJson(csvData: string[]): Array<Record<string, unknown>> {
  if (csvData.length === 0) return [];

  const headers = parseCSVLine(csvData[0]);
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 1; i < csvData.length; i++) {
    const values = parseCSVLine(csvData[i]);
    const row: Record<string, unknown> = {};

    headers.forEach((header, index) => {
      const value = values[index]?.trim() || '';
      // Try to parse numbers and booleans
      if (value === '') {
        row[header] = null;
      } else if (value === 'true') {
        row[header] = true;
      } else if (value === 'false') {
        row[header] = false;
      } else if (!isNaN(Number(value)) && value !== '') {
        row[header] = Number(value);
      } else {
        row[header] = value;
      }
    });

    rows.push(row);
  }

  return rows;
}

export async function fetchRowsFromDataset({
  dataset,
  logger,
  limit = 1000,
  accessToken,
}: {
  dataset: HuggingFaceDatasetSpec;
  logger: Logger;
  limit?: number;
  accessToken: string;
}): Promise<Array<Record<string, unknown>>> {
  const options = {
    repo: dataset.repo,
    path: dataset.file,
    revision: dataset.revision ?? 'main',
    hubUrl: `https://huggingface.co/datasets`,
    accessToken,
  };

  const fileInfo = await fileDownloadInfo(options);

  if (!fileInfo) {
    throw new Error(
      `Cannot fetch files for dataset (${dataset.repo}/${dataset.file}@${options.revision})`
    );
  }

  const { url, size } = fileInfo;

  // Add authentication headers for fetch request
  const fetchHeaders: Record<string, string> = {};
  if (accessToken) {
    fetchHeaders.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(url, { headers: fetchHeaders });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} while fetching ${url}`);
  }

  const inputStream = Readable.fromWeb(res.body as unknown as streamWeb.ReadableStream<any>);

  const isGzip = new URL(url).searchParams.get('response-content-type') === 'application/gzip';

  const totalMb = toMb(size);

  let downloadedBytes = 0;

  let lastDownloadLog = Date.now();

  inputStream.on('data', (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    const now = Date.now();
    if (now - lastDownloadLog >= 10_000) {
      lastDownloadLog = now;
      const downloadedMb = toMb(downloadedBytes);
      logger.info(`Downloading ${dataset.name}: ${downloadedMb} out of ${totalMb} so far`);
      lastDownloadLog = now;
    }
  });

  inputStream.on('end', () => {
    logger.info('Completed download');
  });

  inputStream.on('error', (err) => {
    logger.info(`Ended download prematurely: ${format(err)}`);
  });

  const decompressed: Readable = isGzip ? inputStream.pipe(createGunzip()) : inputStream;

  const rl = readline.createInterface({ input: decompressed, crlfDelay: Infinity });

  const docs: Array<Record<string, unknown>> = [];

  // Check if this is a CSV file based on the file extension
  const isCSV = dataset.file.toLowerCase().endsWith('.csv');

  if (isCSV) {
    // Handle CSV files
    const csvLines: string[] = [];
    for await (const line of rl) {
      if (line.trim()) {
        csvLines.push(line);
      }
    }

    logger.info(`Found ${csvLines.length} lines in CSV file`);

    const jsonData = csvToJson(csvLines);
    logger.info(`Converted to ${jsonData.length} JSON objects`);

    for (const raw of jsonData) {
      const doc = dataset.mapDocument(raw);
      const cleanedDoc = pickBy(doc, (val) => val !== undefined && val !== null && val !== '');

      logger.info(
        `Processing document with ID: ${cleanedDoc._id}, keys: ${Object.keys(cleanedDoc).join(
          ', '
        )}`
      );
      logger.info(`Original doc: ${JSON.stringify(doc, null, 2)}`);
      logger.info(`Cleaned doc: ${JSON.stringify(cleanedDoc, null, 2)}`);
      docs.push(cleanedDoc);

      if (docs.length === limit) {
        logger.info(`Reached limit of ${limit} documents`);
        break;
      }
    }
  } else {
    // Handle JSONL files (existing logic)
    for await (const line of rl) {
      if (!line) continue;
      const raw = JSON.parse(line);
      const doc = dataset.mapDocument(raw);
      docs.push(pickBy(doc, (val) => val !== undefined && val !== null && val !== ''));

      if (docs.length === limit) {
        break;
      }
    }
  }

  inputStream.destroy();

  logger.debug(`Fetched ${docs.length} rows for ${dataset.name}`);

  return docs;
}
