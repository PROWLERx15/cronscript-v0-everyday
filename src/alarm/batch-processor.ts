/**
 * Batch processor for all unprocessed alarm pools
 * 
 * Finds and processes all alarm pools that have claim_ready = false
 */

import { findUnprocessedAlarmPools } from '../core/database.js';
import { processAlarmPool } from './processor.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('alarm-batch-processor');

/**
 * Delay between processing pools (milliseconds)
 */
const INTER_POOL_DELAY_MS = 3000; // 3 seconds

/**
 * Result of batch processing
 */
export interface BatchProcessingResult {
  success: number;
  failed: number;
  total: number;
  results: Array<{
    day: number;
    period: 0 | 1;
    success: boolean;
    message?: string;
    txHash?: string;
  }>;
}

/**
 * Process all unprocessed alarm pools
 * 
 * @param force Skip time buffer check for all pools
 * @returns Batch processing result with success/fail counts
 */
export async function processAllAlarmPools(
  force = false
): Promise<BatchProcessingResult> {
  log.info('Starting batch processing of all unprocessed alarm pools');

  // Find all unprocessed pools
  const pools = await findUnprocessedAlarmPools();

  if (pools.length === 0) {
    log.info('No unprocessed alarm pools found');
    return {
      success: 0,
      failed: 0,
      total: 0,
      results: [],
    };
  }

  log.info({ poolCount: pools.length }, 'Found unprocessed alarm pools');

  let successCount = 0;
  let failedCount = 0;
  const results: BatchProcessingResult['results'] = [];

  // Process each pool sequentially
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i]!;
    const poolNumber = i + 1;

    log.info(
      {
        poolNumber,
        total: pools.length,
        day: pool.day,
        period: pool.period,
      },
      `Processing pool ${poolNumber}/${pools.length}`
    );

    try {
      const result = await processAlarmPool(pool.day, pool.period, force);

      if (result.success) {
        successCount++;
        results.push({
          day: pool.day,
          period: pool.period,
          success: true,
          txHash: result.transaction_hash,
        });
        log.info(
          { poolNumber, day: pool.day, period: pool.period },
          `Pool ${poolNumber}/${pools.length} processed successfully`
        );
      } else {
        failedCount++;
        results.push({
          day: pool.day,
          period: pool.period,
          success: false,
          message: result.message,
        });
        log.warn(
          {
            poolNumber,
            day: pool.day,
            period: pool.period,
            message: result.message,
          },
          `Pool ${poolNumber}/${pools.length} completed with issues`
        );
      }
    } catch (error) {
      failedCount++;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      
      results.push({
        day: pool.day,
        period: pool.period,
        success: false,
        message: errorMessage,
      });
      
      log.error(
        {
          poolNumber,
          day: pool.day,
          period: pool.period,
          error,
        },
        `Pool ${poolNumber}/${pools.length} failed`
      );
    }

    // Add delay between pools (except for the last one)
    if (i < pools.length - 1) {
      log.debug(
        { delayMs: INTER_POOL_DELAY_MS },
        'Waiting before processing next pool'
      );
      await delay(INTER_POOL_DELAY_MS);
    }
  }

  // Log summary
  log.info(
    {
      total: pools.length,
      success: successCount,
      failed: failedCount,
    },
    'Batch processing completed'
  );

  return {
    success: successCount,
    failed: failedCount,
    total: pools.length,
    results,
  };
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

