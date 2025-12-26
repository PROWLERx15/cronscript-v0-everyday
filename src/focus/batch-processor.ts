/**
 * Batch processor for focus lock pools
 * 
 * Processes multiple unprocessed focus lock pools sequentially
 * with delays to avoid overwhelming the blockchain/database
 */

import { processFocusLockPool } from './processor.js';
import { findUnprocessedFocusLockPools } from '../core/database.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('focus-batch-processor');

/**
 * Delay between pool processing (3 seconds)
 */
const PROCESSING_DELAY_MS = 3000;

/**
 * Batch processing result
 */
export interface BatchProcessingResult {
  totalPools: number;
  successCount: number;
  failCount: number;
  skippedCount: number;
  failedPools: Array<{
    day: number;
    period: number;
    reason: string;
  }>;
  skippedPools: Array<{
    day: number;
    period: number;
    reason: string;
  }>;
}

/**
 * Process all unprocessed focus lock pools
 * 
 * @param force Skip time buffer check for all pools
 * @returns Batch processing summary
 */
export async function processAllFocusLockPools(
  force = false
): Promise<BatchProcessingResult> {
  log.info('========== BATCH PROCESSING ALL FOCUS LOCK POOLS ==========');
  
  const result: BatchProcessingResult = {
    totalPools: 0,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    failedPools: [],
    skippedPools: [],
  };

  try {
    // Find all unprocessed pools
    const pools = await findUnprocessedFocusLockPools();
    
    if (pools.length === 0) {
      log.info('🎉 All focus lock pools are already processed - nothing to do!');
      return result;
    }

    result.totalPools = pools.length;
    log.info(`📊 Found ${pools.length} unprocessed focus lock pools`);

    // Process each pool sequentially
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i]!;
      
      log.info('======================================================================');
      log.info(`📊 Processing Focus Lock Pool ${i + 1}/${pools.length}: Day ${pool.day}, Period ${pool.period}`);
      log.info('======================================================================');

      try {
        const poolResult = await processFocusLockPool(pool.day, pool.period, force);
        
        if (poolResult.success) {
          result.successCount++;
          log.info(`✅ Pool ${i + 1}/${pools.length} processed successfully\n`);
        } else {
          result.skippedCount++;
          result.skippedPools.push({
            day: pool.day,
            period: pool.period,
            reason: poolResult.message ?? 'Unknown reason',
          });
          log.warn(`⚠️  Pool ${i + 1}/${pools.length} skipped: ${poolResult.message}\n`);
        }
      } catch (error) {
        result.failCount++;
        result.failedPools.push({
          day: pool.day,
          period: pool.period,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
        log.error(
          { error, pool: { day: pool.day, period: pool.period } },
          `❌ Pool ${i + 1}/${pools.length} failed\n`
        );
      }

      // Add delay between pools (except after last one)
      if (i < pools.length - 1) {
        log.info(`⏳ Waiting ${PROCESSING_DELAY_MS / 1000} seconds before next pool...\n`);
        await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS));
      }
    }

    // Print summary
    log.info('🎉 ========== BATCH PROCESSING COMPLETE ==========');
    log.info(`📊 Total Pools: ${result.totalPools}`);
    log.info(`✅ Successfully Processed: ${result.successCount}`);
    log.info(`⚠️  Skipped: ${result.skippedCount}`);
    log.info(`❌ Failed: ${result.failCount}`);

    if (result.skippedPools.length > 0) {
      log.info('\n⚠️  Skipped Pools:');
      for (const pool of result.skippedPools) {
        log.info(`   Day ${pool.day}, Period ${pool.period}: ${pool.reason}`);
      }
    }

    if (result.failedPools.length > 0) {
      log.info('\n❌ Failed Pools:');
      for (const pool of result.failedPools) {
        log.info(`   Day ${pool.day}, Period ${pool.period}: ${pool.reason}`);
      }
    }

    log.info('================================================\n');

    return result;
  } catch (error) {
    log.error({ error }, 'Batch processing failed');
    throw error;
  }
}
