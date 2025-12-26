/**
 * Combined Cron Processor for Alarm and Focus Lock Pools
 *
 * Designed to run at:
 * - 0:30 UTC → Process Period 1 from previous day (12:00-23:59)
 * - 12:30 UTC → Process Period 0 from current day (00:00-11:59)
 *
 * The 30-minute delay after period end provides a safety buffer for late submissions.
 */

import { ProcessingResult, PoolInfo } from '../types/common.js';
import { processAlarmPool } from '../alarm/processor.js';
import { processFocusLockPool } from '../focus/processor.js';
import { processAllAlarmPools } from '../alarm/batch-processor.js';
import { processAllFocusLockPools } from '../focus/batch-processor.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('cron-processor');

/**
 * Result of cron processing operation
 */
export interface CronProcessingResult {
  success: boolean;
  pool: PoolInfo;
  alarm: ProcessingResult;
  focus: ProcessingResult;
  processed_at: string;
  error?: string;
}

/**
 * Result of batch cron processing
 */
export interface CronBatchResult {
  success: boolean;
  alarm: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
  focus: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
  processed_at: string;
}

/**
 * Calculate which pool to process based on current UTC time
 *
 * At 0:30 UTC → Process yesterday's Period 1 (12:00-23:59)
 * At 12:30 UTC → Process today's Period 0 (00:00-11:59)
 *
 * @returns PoolInfo with day and period to process
 */
export function calculatePoolToProcess(): PoolInfo {
  const now = Math.floor(Date.now() / 1000);
  const currentDay = Math.floor(now / 86400);
  const currentHour = Math.floor((now % 86400) / 3600);

  if (currentHour < 12) {
    // Between 00:00-11:59 UTC → Process previous day's Period 1
    return {
      day: currentDay - 1,
      period: 1,
    };
  } else {
    // Between 12:00-23:59 UTC → Process current day's Period 0
    return {
      day: currentDay,
      period: 0,
    };
  }
}

/**
 * Process both alarm and focus lock pools for the scheduled period
 *
 * Runs sequentially: alarm first, then focus lock
 * Errors in one pool type don't prevent the other from processing
 *
 * @param force Skip the 30-minute time buffer check
 * @returns Combined processing result
 */
export async function processCronPools(force = false): Promise<CronProcessingResult> {
  const pool = calculatePoolToProcess();
  const processedAt = new Date().toISOString();

  log.info(
    {
      pool,
      force,
      currentTime: processedAt,
    },
    'Starting cron pool processing'
  );

  let alarmResult: ProcessingResult = {
    success: false,
    message: 'Not processed',
  };

  let focusResult: ProcessingResult = {
    success: false,
    message: 'Not processed',
  };

  // Process alarm pool
  log.info({ pool }, 'Processing alarm pool');
  try {
    alarmResult = await processAlarmPool(pool.day, pool.period, force);
    log.info(
      {
        success: alarmResult.success,
        message: alarmResult.message,
        txHash: alarmResult.transaction_hash,
      },
      'Alarm pool processing completed'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage, pool }, 'Alarm pool processing failed');
    alarmResult = {
      success: false,
      message: `Alarm processing error: ${errorMessage}`,
    };
  }

  // Add delay between pool types to avoid overwhelming the system
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Process focus lock pool
  log.info({ pool }, 'Processing focus lock pool');
  try {
    focusResult = await processFocusLockPool(pool.day, pool.period, force);
    log.info(
      {
        success: focusResult.success,
        message: focusResult.message,
        txHash: focusResult.transaction_hash,
      },
      'Focus lock pool processing completed'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage, pool }, 'Focus lock pool processing failed');
    focusResult = {
      success: false,
      message: `Focus lock processing error: ${errorMessage}`,
    };
  }

  const overallSuccess = alarmResult.success || focusResult.success;

  log.info(
    {
      pool,
      alarmSuccess: alarmResult.success,
      focusSuccess: focusResult.success,
      overallSuccess,
    },
    'Cron pool processing completed'
  );

  return {
    success: overallSuccess,
    pool,
    alarm: alarmResult,
    focus: focusResult,
    processed_at: processedAt,
  };
}

/**
 * Process all unprocessed pools for both alarm and focus lock
 *
 * @param force Skip the 30-minute time buffer check
 * @returns Combined batch processing result
 */
export async function processAllCronPools(force = false): Promise<CronBatchResult> {
  const processedAt = new Date().toISOString();

  log.info({ force }, 'Starting batch cron processing for all unprocessed pools');

  // Process all alarm pools
  log.info('Processing all unprocessed alarm pools');
  const alarmBatchResult = await processAllAlarmPools(force);

  log.info(
    {
      total: alarmBatchResult.total,
      success: alarmBatchResult.success,
      failed: alarmBatchResult.failed,
    },
    'Alarm batch processing completed'
  );

  // Add delay between pool types
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Process all focus lock pools
  log.info('Processing all unprocessed focus lock pools');
  const focusBatchResult = await processAllFocusLockPools(force);

  log.info(
    {
      total: focusBatchResult.totalPools,
      success: focusBatchResult.successCount,
      failed: focusBatchResult.failCount,
      skipped: focusBatchResult.skippedCount,
    },
    'Focus lock batch processing completed'
  );

  const overallSuccess = alarmBatchResult.failed === 0 && focusBatchResult.failCount === 0;

  log.info(
    {
      overallSuccess,
      alarm: {
        total: alarmBatchResult.total,
        success: alarmBatchResult.success,
        failed: alarmBatchResult.failed,
      },
      focus: {
        total: focusBatchResult.totalPools,
        success: focusBatchResult.successCount,
        failed: focusBatchResult.failCount,
      },
    },
    'Batch cron processing completed'
  );

  return {
    success: overallSuccess,
    alarm: {
      total: alarmBatchResult.total,
      success: alarmBatchResult.success,
      failed: alarmBatchResult.failed,
      skipped: 0, // alarm batch processor doesn't track skipped
    },
    focus: {
      total: focusBatchResult.totalPools,
      success: focusBatchResult.successCount,
      failed: focusBatchResult.failCount,
      skipped: focusBatchResult.skippedCount,
    },
    processed_at: processedAt,
  };
}
