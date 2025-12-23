/**
 * Alarm pool finder utilities
 * 
 * Provides functions to:
 * - Find latest alarm pool with alarms
 * - Find all unprocessed alarm pools
 * - Get current pool info
 */

import {
  findLatestAlarmPool as dbFindLatestAlarmPool,
  findUnprocessedAlarmPools as dbFindUnprocessedAlarmPools,
  calculatePoolInfo,
} from '../core/database.js';
import { PoolInfo } from '../types/common.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('alarm-finder');

/**
 * Find the latest alarm pool with alarms
 * @returns Pool info or null if no alarms found
 */
export async function findLatestAlarmPool(): Promise<PoolInfo | null> {
  log.info('Finding latest alarm pool');
  const poolInfo = await dbFindLatestAlarmPool();
  
  if (poolInfo) {
    log.info(
      { day: poolInfo.day, period: poolInfo.period },
      'Found latest alarm pool'
    );
  } else {
    log.warn('No alarm pools found');
  }
  
  return poolInfo;
}

/**
 * Find all unprocessed alarm pools
 * @returns Array of pool infos that need processing
 */
export async function findUnprocessedAlarmPools(): Promise<PoolInfo[]> {
  log.info('Finding unprocessed alarm pools');
  const pools = await dbFindUnprocessedAlarmPools();
  
  log.info({ poolCount: pools.length }, 'Found unprocessed alarm pools');
  
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

