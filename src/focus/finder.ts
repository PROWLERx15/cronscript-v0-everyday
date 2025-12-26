/**
 * Focus lock pool finder utilities
 * 
 * Provides functions to:
 * - Find latest focus lock pool with locks
 * - Find all unprocessed focus lock pools
 * - Get current pool info
 */

import {
  findLatestFocusLockPool as dbFindLatestFocusLockPool,
  findUnprocessedFocusLockPools as dbFindUnprocessedFocusLockPools,
  calculatePoolInfo,
} from '../core/database.js';
import { PoolInfo } from '../types/common.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('focus-finder');

/**
 * Find the latest focus lock pool with locks
 * @returns Pool info or null if no locks found
 */
export async function findLatestFocusLockPool(): Promise<PoolInfo | null> {
  log.info('Finding latest focus lock pool');
  const poolInfo = await dbFindLatestFocusLockPool();
  
  if (poolInfo) {
    log.info(
      { day: poolInfo.day, period: poolInfo.period },
      'Found latest focus lock pool'
    );
  } else {
    log.warn('No focus lock pools found');
  }
  
  return poolInfo;
}

/**
 * Find all unprocessed focus lock pools
 * @returns Array of pool infos that need processing
 */
export async function findUnprocessedFocusLockPools(): Promise<PoolInfo[]> {
  log.info('Finding unprocessed focus lock pools');
  const pools = await dbFindUnprocessedFocusLockPools();
  
  log.info({ poolCount: pools.length }, 'Found unprocessed focus lock pools');
  
  return pools;
}

/**
 * Get current pool info based on current time
 * @returns Pool info for the current 12-hour period
 */
export function getCurrentPoolInfo(): PoolInfo {
  const now = Math.floor(Date.now() / 1000);
  const poolInfo = calculatePoolInfo(now);
  
  log.info(
    {
      day: poolInfo.day,
      period: poolInfo.period,
      timestamp: now,
    },
    'Calculated current pool info'
  );
  
  return poolInfo;
}

/**
 * Display pool information in a formatted way
 */
export function displayPoolInfo(poolInfo: PoolInfo): string {
  const { day, period } = poolInfo;
  const periodName = period === 0 ? 'AM (00:00-11:59 UTC)' : 'PM (12:00-23:59 UTC)';
  
  // Calculate actual date range
  const periodStart = day * 86400 + period * 43200;
  const periodEnd = periodStart + 43200;
  const startDate = new Date(periodStart * 1000);
  const endDate = new Date(periodEnd * 1000);
  
  return [
    `Day: ${day}`,
    `Period: ${period} (${periodName})`,
    `Start: ${startDate.toISOString()}`,
    `End: ${endDate.toISOString()}`,
  ].join('\n');
}
