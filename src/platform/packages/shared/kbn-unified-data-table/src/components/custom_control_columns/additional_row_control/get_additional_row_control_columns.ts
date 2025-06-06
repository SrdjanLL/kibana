/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { RowControlColumn } from '@kbn/discover-utils';
import { getRowControlColumn } from './row_control_column';
import { getRowMenuControlColumn } from './row_menu_control_column';

export const getAdditionalRowControlColumns = (rowControlColumns: RowControlColumn[]) => {
  if (rowControlColumns.length <= 2) {
    return rowControlColumns.map(getRowControlColumn);
  }

  return [
    getRowControlColumn(rowControlColumns[0]),
    getRowMenuControlColumn(rowControlColumns.slice(1)),
  ];
};
