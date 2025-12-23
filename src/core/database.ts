/**
 * Database operations using Supabase client
 * 
 * Handles:
 * - Fetching alarm/focus lock data from pools
 * - Finding unprocessed pools
 * - Storing processing results (signatures, proofs, merkle roots)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { PoolInfo, PoolTimeRange, RewardData, MerkleTree } from '../types/index.js';
import {
  AlarmUser,
  DatabaseAlarmRecord,
  AlarmBatchUpdate,
  ClaimDataInsert,
  AlarmPoolConfig,
} from '../types/alarm.js';
import { getCoreConfig } from './config.js';
import { createModuleLogger, logDatabaseOperation } from './logger.js';

const log = createModuleLogger('database');

let supabaseClient: SupabaseClient | null = null;

/**
 * Initialize Supabase client
 */
function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const { supabaseUrl, supabaseServiceKey } = getCoreConfig();
    supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
    log.info('Supabase client initialized');
  }
  return supabaseClient;
}

/**
 * Calculate pool info (day and period) from timestamp
 * 
 * @param timestamp Unix timestamp
 * @returns Pool info with day and period
 */
export function calculatePoolInfo(timestamp: number): PoolInfo {
  const day = Math.floor(timestamp / 86400);
  const period = Math.floor((timestamp % 86400) / 43200) as 0 | 1;
  return { day, period };
}

/**
 * Calculate time range for a pool period
 * 
 * @param day Unix day
 * @param period 0=AM, 1=PM
 * @returns Start and end timestamps for the period
 */
export function calculateTimeRange(day: number, period: 0 | 1): PoolTimeRange {
  const dayStart = day * 86400;
  const periodStart = dayStart + period * 43200;
  const periodEnd = periodStart + 43200;
  return { periodStart, periodEnd };
}

/**
 * Fetch alarms from a specific pool
 * 
 * Filters:
 * - Time range (wakeup_time within period)
 * - Only staked (stake_amount > 0)
 * - Only blockchain (alarm_id IS NOT NULL)
 * - Not deleted (deleted = false)
 * 
 * @returns Array of alarm users
 */
export async function fetchAlarmsFromPool(
  day: number,
  period: 0 | 1
): Promise<AlarmUser[]> {
  const supabase = getSupabaseClient();
  const { periodStart, periodEnd } = calculateTimeRange(day, period);

  log.info(
    {
      day,
      period,
      periodStart,
      periodEnd,
      startDate: new Date(periodStart * 1000).toISOString(),
      endDate: new Date(periodEnd * 1000).toISOString(),
    },
    'Fetching alarms from pool'
  );

  const { data: alarms, error } = await supabase
    .from('alarms')
    .select(
      `
      *,
      profiles!inner(wallet_address)
    `
    )
    .gte('wakeup_time', periodStart)
    .lt('wakeup_time', periodEnd)
    .gt('stake_amount', 0)
    .not('alarm_id', 'is', null)
    .eq('deleted', false)
    .order('wakeup_time');

  if (error) {
    log.error({ error }, 'Failed to fetch alarms from database');
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!alarms || alarms.length === 0) {
    log.warn({ day, period }, 'No alarms found for pool');
    return [];
  }

  // Transform database records to AlarmUser type
  const transformedAlarms: AlarmUser[] = alarms.map((alarm) => {
    const record = alarm as unknown as DatabaseAlarmRecord;
    
    // Convert stake_amount from USDC (DB: NUMERIC(10,2)) to smallest unit (6 decimals)
    // DB stores as 50.00, blockchain uses 50000000
    const stakeAmountUsdc = record.stake_amount;
    const stakeAmountSmallestUnit = BigInt(Math.floor(stakeAmountUsdc * 1e6));

    return {
      address: record.profiles?.wallet_address ?? '',
      wake_up_time: record.wakeup_time.toString(),
      stake_amount: stakeAmountSmallestUnit.toString(),
      snooze_count: record.snooze_count,
      alarm_uuid: record.id,
      alarm_id: record.alarm_id?.toString() ?? '0',
      uuid: record.id,
      id: record.alarm_id?.toString() ?? '0',
    };
  });

  logDatabaseOperation('fetch_alarms', transformedAlarms.length, {
    day,
    period,
  });

  return transformedAlarms;
}

/**
 * Find all unprocessed alarm pools
 * 
 * Returns pools with claim_ready = false, filtered to exclude
 * pools older than 48h (legacy contracts)
 */
export async function findUnprocessedAlarmPools(): Promise<PoolInfo[]> {
  const supabase = getSupabaseClient();

  log.info('Finding unprocessed alarm pools');

  const { data: alarms, error } = await supabase
    .from('alarms')
    .select('wakeup_time')
    .eq('claim_ready', false)
    .order('wakeup_time', { ascending: true });

  if (error) {
    log.error({ error }, 'Failed to find unprocessed pools');
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!alarms || alarms.length === 0) {
    log.info('No unprocessed alarms found');
    return [];
  }

  // Filter out pools older than 48h (legacy)
  const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  const recentAlarms = alarms.filter((a) => a.wakeup_time >= cutoff);

  if (recentAlarms.length === 0) {
    log.info(
      { totalAlarms: alarms.length },
      'All unprocessed alarms are older than 48h'
    );
    return [];
  }

  if (recentAlarms.length !== alarms.length) {
    log.info(
      {
        skipped: alarms.length - recentAlarms.length,
        kept: recentAlarms.length,
      },
      'Filtered out old alarms'
    );
  }

  // Group by unique (day, period)
  const poolsSet = new Set<string>();
  const pools: PoolInfo[] = [];

  for (const alarm of recentAlarms) {
    const poolInfo = calculatePoolInfo(alarm.wakeup_time);
    const poolKey = `${poolInfo.day}_${poolInfo.period}`;

    if (!poolsSet.has(poolKey)) {
      poolsSet.add(poolKey);
      pools.push(poolInfo);
    }
  }

  log.info(
    { poolCount: pools.length, alarmCount: recentAlarms.length },
    'Found unprocessed pools'
  );

  return pools;
}

/**
 * Find the latest alarm pool with alarms
 */
export async function findLatestAlarmPool(): Promise<PoolInfo | null> {
  const supabase = getSupabaseClient();

  log.info('Finding latest alarm pool');

  // Try with profiles join first
  const { data: alarms, error } = await supabase
    .from('alarms')
    .select(
      `
      wakeup_time,
      profiles!inner(wallet_address)
    `
    )
    .order('wakeup_time', { ascending: false })
    .limit(1);

  if (error) {
    log.warn({ error }, 'Query with profiles join failed, trying without');

    // Fallback: try without profiles join
    const fallback = await supabase
      .from('alarms')
      .select('wakeup_time')
      .order('wakeup_time', { ascending: false })
      .limit(1);
    if (fallback.error) {
      log.error({ error: fallback.error }, 'Failed to find latest pool');
      throw new Error(`Database query failed: ${fallback.error.message}`);
    }
    
    if (!fallback.data || fallback.data.length === 0) {
      log.warn('No alarms found in database (fallback)');
      return null;
    }
    
    const latestWakeupTime = fallback.data[0]!.wakeup_time;
    const poolInfo = calculatePoolInfo(latestWakeupTime);

    log.info(
      {
        day: poolInfo.day,
        period: poolInfo.period,
        latestWakeupTime,
        date: new Date(latestWakeupTime * 1000).toISOString(),
      },
      'Found latest alarm pool (fallback)'
    );

    return poolInfo;
  }

  if (!alarms || alarms.length === 0) {
    log.warn('No alarms found in database');
    return null;
  }

  const latestWakeupTime = alarms[0]!.wakeup_time;
  const poolInfo = calculatePoolInfo(latestWakeupTime);

  log.info(
    {
      day: poolInfo.day,
      period: poolInfo.period,
      latestWakeupTime,
      date: new Date(latestWakeupTime * 1000).toISOString(),
    },
    'Found latest alarm pool'
  );

  return poolInfo;
}

/**
 * Store alarm processing results to database
 * 
 * Steps:
 * 1. Batch update alarms table (claim_ready = true, has_claimed = false)
 * 2. Batch insert claim data with signatures and proofs
 * 
 * IMPORTANT: Only call this AFTER blockchain transaction succeeds!
 */
export async function storeAlarmResults(
  users: AlarmUser[],
  rewards: RewardData[],
  merkleTree: MerkleTree,
  config: AlarmPoolConfig,
  chainId: string,
  expiry: number
): Promise<void> {
  const supabase = getSupabaseClient();

  log.info({ userCount: users.length }, 'Storing alarm results to database');

  // Prepare batch updates and inserts
  const alarmUpdates: AlarmBatchUpdate[] = [];
  const claimDataInserts: ClaimDataInsert[] = [];

  // Import crypto functions for signature generation
  const { createAlarmOutcomeSignature } = await import('./crypto.js');

  for (const user of users) {
    // Find reward for this user
    const userReward = rewards.find((r) => r.address === user.address);
    const rewardAmount = userReward ? userReward.reward_amount : '0';

    // Get merkle proof (all users have proofs, including losers)
    const merkleProof = merkleTree.proofs[user.address] ?? [];

    // Generate SNIP-12 signature
    const signature = createAlarmOutcomeSignature(
      user.address,
      BigInt(user.alarm_id),
      BigInt(user.wake_up_time),
      user.snooze_count,
      BigInt(expiry),
      config.contract_address,
      chainId,
      config.verifier_private_key
    );

    // Prepare alarm update
    alarmUpdates.push({
      id: user.alarm_uuid,
      claim_ready: true,
      has_claimed: false,
    });

    // Prepare claim data insert
    claimDataInserts.push({
      alarm_id: user.alarm_uuid,
      signature_r: signature.signature_r,
      signature_s: signature.signature_s,
      message_hash: signature.message_hash,
      reward_amount: rewardAmount,
      merkle_proof: JSON.stringify(merkleProof),
      expiry_time: expiry,
      processed_at: new Date().toISOString(),
    });
  }

  // Batch update alarms
  log.info({ count: alarmUpdates.length }, 'Updating alarm records');
  
  for (const update of alarmUpdates) {
    const { error } = await supabase
      .from('alarms')
      .update({
        claim_ready: update.claim_ready,
        has_claimed: update.has_claimed,
      })
      .eq('id', update.id);

    if (error) {
      log.error({ error, alarmId: update.id }, 'Failed to update alarm');
      throw new Error(`Failed to update alarm ${update.id}: ${error.message}`);
    }
  }

  logDatabaseOperation('update_alarms', alarmUpdates.length);

  // Batch insert claim data
  log.info({ count: claimDataInserts.length }, 'Inserting claim data');
  
  const { error: insertError } = await supabase
    .from('user_claim_data')
    .insert(claimDataInserts);

  if (insertError) {
    log.error({ error: insertError }, 'Failed to insert claim data');
    throw new Error(`Failed to insert claim data: ${insertError.message}`);
  }

  logDatabaseOperation('insert_claim_data', claimDataInserts.length);

  log.info('Successfully stored all results to database');
}

