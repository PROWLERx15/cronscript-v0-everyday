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
import {
  FocusLockUser,
  DatabaseFocusLockRecord,
  FocusLockClaimData,
  FocusLockPoolConfig,
  FocusLockReward,
} from '../types/focus.js';
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

  // First fetch alarms
  const { data: alarms, error } = await supabase
    .from('alarms')
    .select('*')
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

  // Get user IDs to fetch wallet addresses from wallets table (Privy wallets)
  const userIds = [...new Set(alarms.map((alarm) => alarm.user_id))];

  // Fetch wallet addresses from wallets table (deployed_address is the on-chain address)
  const { data: wallets, error: walletsError } = await supabase
    .from('wallets')
    .select('user_id, deployed_address')
    .in('user_id', userIds)
    .eq('is_deployed', true);

  if (walletsError) {
    log.error({ error: walletsError }, 'Failed to fetch wallet addresses');
    throw new Error(`Database query failed: ${walletsError.message}`);
  }

  // Create a map of user_id -> deployed_address
  const walletMap = new Map<string, string>();
  wallets?.forEach((wallet) => {
    if (wallet.deployed_address) {
      walletMap.set(wallet.user_id, wallet.deployed_address);
    }
  });

  // Transform database records to AlarmUser type
  const transformedAlarms: AlarmUser[] = alarms
    .filter((alarm) => walletMap.has(alarm.user_id)) // Only include alarms with valid wallet addresses
    .map((alarm) => {
      const record = alarm as unknown as DatabaseAlarmRecord;

      // Convert stake_amount from USDC (DB: NUMERIC(10,2)) to smallest unit (6 decimals)
      // DB stores as 50.00, blockchain uses 50000000
      const stakeAmountUsdc = record.stake_amount;
      const stakeAmountSmallestUnit = BigInt(Math.floor(stakeAmountUsdc * 1e6));

      return {
        address: walletMap.get(record.user_id) ?? '',
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

  // Find the latest alarm with a valid alarm_id and stake
  const { data: alarms, error } = await supabase
    .from('alarms')
    .select('wakeup_time, alarm_id')
    .gt('stake_amount', 0)
    .not('alarm_id', 'is', null)
    .eq('deleted', false)
    .order('wakeup_time', { ascending: false })
    .limit(1);

  if (error) {
    log.error({ error }, 'Failed to find latest alarm pool');
    throw new Error(`Database query failed: ${error.message}`);
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
      alarmId: alarms[0]!.alarm_id,
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

/**
 * Fetch focus locks from a specific pool
 *
 * Filters by day and period columns (not time range) to match what was stored
 * on-chain, even if period calculations differ.
 *
 * Only periods 0-1 are valid for 12-hour pools.
 *
 * @returns Array of focus lock users
 */
export async function fetchFocusLocksFromPool(
  day: number,
  period: 0 | 1
): Promise<FocusLockUser[]> {
  const supabase = getSupabaseClient();

  log.info(
    {
      day,
      period,
    },
    'Fetching focus locks from pool'
  );

  // Validate period (only 0-1 valid for 12-hour periods)
  if (period >= 2) {
    log.warn(
      { day, period },
      'Invalid period requested - only periods 0-1 are supported (12-hour pools)'
    );
    return [];
  }

  // First fetch focus locks
  const { data: locks, error } = await supabase
    .from('focus_locks')
    .select('*')
    .eq('day', day)
    .eq('period', period)
    .gt('stake_amount', 0)
    .not('lock_id', 'is', null)
    .order('start_time');

  if (error) {
    log.error({ error }, 'Failed to fetch focus locks from database');
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!locks || locks.length === 0) {
    log.warn({ day, period }, 'No focus locks found for pool');
    return [];
  }

  // Get user IDs to fetch wallet addresses from wallets table (Privy wallets)
  const userIds = [...new Set(locks.map((lock) => lock.user_id))];

  // Fetch wallet addresses from wallets table (deployed_address is the on-chain address)
  const { data: wallets, error: walletsError } = await supabase
    .from('wallets')
    .select('user_id, deployed_address')
    .in('user_id', userIds)
    .eq('is_deployed', true);

  if (walletsError) {
    log.error({ error: walletsError }, 'Failed to fetch wallet addresses');
    throw new Error(`Database query failed: ${walletsError.message}`);
  }

  // Create a map of user_id -> deployed_address
  const walletMap = new Map<string, string>();
  wallets?.forEach((wallet) => {
    if (wallet.deployed_address) {
      walletMap.set(wallet.user_id, wallet.deployed_address);
    }
  });

  // Transform database records to FocusLockUser type
  const transformedLocks: FocusLockUser[] = locks
    .filter((lock) => walletMap.has(lock.user_id)) // Only include locks with valid wallet addresses
    .map((lock) => {
      const record = lock as unknown as DatabaseFocusLockRecord;

      // Convert stake_amount from USDC (DB: NUMERIC) to smallest unit (6 decimals)
      // DB stores as NUMERIC(10,2) = USDC (e.g., "1.00"), blockchain uses 1000000
      const stakeAmountUsdc = parseFloat(record.stake_amount);
      const stakeAmountSmallestUnit = BigInt(Math.floor(stakeAmountUsdc * 1e6));

      // Convert duration from minutes to seconds
      const durationSeconds = record.duration_minutes * 60;

      return {
        address: walletMap.get(record.user_id) ?? '',
        session_id: BigInt(record.lock_id ?? 0),
        start_time: BigInt(record.start_time),
        duration: BigInt(durationSeconds),
        stake_amount: stakeAmountSmallestUnit.toString(),
        completion_status: record.completion_status ?? false,
        focus_lock_id: record.id,
        uuid: record.id,
        id: record.lock_id?.toString() ?? '0',
      };
    });

  logDatabaseOperation('fetch_focus_locks', transformedLocks.length, {
    day,
    period,
  });

  log.info(
    { lockCount: transformedLocks.length },
    'Successfully fetched and transformed focus locks'
  );

  return transformedLocks;
}

/**
 * Find all unprocessed focus lock pools
 *
 * Returns pools with claim_ready = false, filtered to exclude
 * pools older than 48h (contract limitation)
 */
export async function findUnprocessedFocusLockPools(): Promise<PoolInfo[]> {
  const supabase = getSupabaseClient();

  log.info('Finding unprocessed focus lock pools');

  const { data: locks, error } = await supabase
    .from('focus_locks')
    .select('id, start_time, duration_minutes, day, period')
    .eq('claim_ready', false)
    .order('start_time', { ascending: true });

  if (error) {
    log.error({ error }, 'Failed to find unprocessed focus lock pools');
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!locks || locks.length === 0) {
    log.info('No unprocessed focus locks found');
    return [];
  }

  // Calculate cutoff time (48 hours ago)
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 48 * 3600;

  // Filter locks by end time (must be within 48 hours)
  // Fix invalid periods by recalculating from start_time
  const recentLocks = locks.filter((lock) => {
    // Fix invalid periods (2-3 from old 6-hour system) by recalculating
    if (lock.period >= 2) {
      const correctPoolInfo = calculatePoolInfo(lock.start_time);
      log.info(
        {
          lockId: lock.id.substring(0, 8),
          oldPeriod: lock.period,
          correctPeriod: correctPoolInfo.period,
        },
        'Fixing invalid period'
      );
      // Update the lock object with correct values
      lock.day = correctPoolInfo.day;
      lock.period = correctPoolInfo.period;
    }

    const endTime = lock.start_time + lock.duration_minutes * 60;
    const isRecent = endTime >= cutoff;

    if (!isRecent) {
      const hoursAgo = Math.floor((now - endTime) / 3600);
      log.debug(
        { lockId: lock.id.substring(0, 8), hoursAgo },
        'Skipping old lock (too old for contract)'
      );
    }

    return isRecent;
  });

  if (recentLocks.length === 0) {
    log.info(
      { totalLocks: locks.length },
      'All unprocessed locks are older than 48h'
    );
    return [];
  }

  if (recentLocks.length !== locks.length) {
    log.info(
      {
        skipped: locks.length - recentLocks.length,
        kept: recentLocks.length,
      },
      'Filtered out old focus locks'
    );
  }

  // Group locks by unique (day, period)
  const poolsSet = new Set<string>();
  const pools: PoolInfo[] = [];

  for (const lock of recentLocks) {
    const poolKey = `${lock.day}_${lock.period}`;

    if (!poolsSet.has(poolKey)) {
      poolsSet.add(poolKey);
      pools.push({
        day: lock.day,
        period: lock.period as 0 | 1,
      });
    }
  }

  log.info(
    { poolCount: pools.length, lockCount: recentLocks.length },
    'Found unprocessed focus lock pools'
  );

  return pools;
}

/**
 * Find the latest focus lock pool with locks
 */
export async function findLatestFocusLockPool(): Promise<PoolInfo | null> {
  const supabase = getSupabaseClient();

  log.info('Finding latest focus lock pool');

  // Find the latest focus lock with a valid lock_id and stake
  const { data: locks, error } = await supabase
    .from('focus_locks')
    .select('start_time, day, period, lock_id')
    .gt('stake_amount', 0)
    .not('lock_id', 'is', null)
    .order('start_time', { ascending: false })
    .limit(1);

  if (error) {
    log.error({ error }, 'Failed to find latest focus lock pool');
    throw new Error(`Database query failed: ${error.message}`);
  }

  if (!locks || locks.length === 0) {
    log.warn('No focus locks found in database');
    return null;
  }

  const latestLock = locks[0]!;
  const latestStartTime = latestLock.start_time;

  // Use day/period from database if available, otherwise calculate
  const poolInfo: PoolInfo = {
    day: latestLock.day ?? Math.floor(latestStartTime / 86400),
    period: (latestLock.period ?? Math.floor((latestStartTime % 86400) / 43200)) as 0 | 1,
  };

  log.info(
    {
      day: poolInfo.day,
      period: poolInfo.period,
      latestStartTime,
      lockId: latestLock.lock_id,
      date: new Date(latestStartTime * 1000).toISOString(),
    },
    'Found latest focus lock pool'
  );

  return poolInfo;
}

/**
 * Store focus lock processing results to database
 *
 * Steps:
 * 1. Batch update focus_locks table (claim_ready = true, has_claimed = false)
 * 2. Batch insert claim data with signatures and proofs
 *
 * IMPORTANT: Only call this AFTER blockchain transaction succeeds!
 */
export async function storeFocusLockResults(
  users: FocusLockUser[],
  rewards: FocusLockReward[],
  merkleTree: MerkleTree,
  config: FocusLockPoolConfig,
  chainId: string,
  expiry: number
): Promise<void> {
  const supabase = getSupabaseClient();

  log.info({ userCount: users.length }, 'Storing focus lock results to database');

  // Prepare batch updates and inserts
  const lockUpdates: Array<{ id: string; claim_ready: boolean; has_claimed: boolean }> = [];
  const claimDataInserts: FocusLockClaimData[] = [];

  // Import crypto functions for signature generation
  const { createFocusOutcomeSignature } = await import('./crypto.js');

  for (const user of users) {
    // Find reward for this lock
    const userReward = rewards.find(
      (r) => r.address === user.address && BigInt(r.session_id) === user.session_id
    );
    const rewardAmount = userReward ? userReward.reward_amount : '0';

    // Get merkle proof (keyed by address_sessionid)
    const proofKey = `${user.address}_${user.session_id}`;
    const merkleProof = merkleTree.proofs[proofKey] ?? [];

    // Generate SNIP-12 signature
    const signature = createFocusOutcomeSignature(
      user.address,
      user.session_id,
      user.start_time,
      user.duration,
      user.completion_status,
      BigInt(expiry),
      config.contract_address,
      chainId,
      config.verifier_private_key
    );

    // Prepare focus_locks update
    lockUpdates.push({
      id: user.focus_lock_id,
      claim_ready: true,
      has_claimed: false,
    });

    // Prepare claim data insert
    claimDataInserts.push({
      focus_lock_id: user.focus_lock_id,
      signature_r: signature.signature_r,
      signature_s: signature.signature_s,
      message_hash: signature.message_hash,
      reward_amount: rewardAmount.toString(),
      merkle_proof: JSON.stringify(merkleProof),
      expiry_time: expiry,
      processed_at: new Date().toISOString(),
    });
  }

  // Batch update focus_locks
  log.info({ count: lockUpdates.length }, 'Updating focus lock records');

  for (const update of lockUpdates) {
    const { error } = await supabase
      .from('focus_locks')
      .update({
        claim_ready: update.claim_ready,
        has_claimed: update.has_claimed,
      })
      .eq('id', update.id);

    if (error) {
      log.error({ error, lockId: update.id }, 'Failed to update focus lock');
      throw new Error(`Failed to update lock ${update.id}: ${error.message}`);
    }
  }

  logDatabaseOperation('update_focus_locks', lockUpdates.length);

  // Batch insert claim data
  log.info({ count: claimDataInserts.length }, 'Inserting focus lock claim data');

  const { error: insertError } = await supabase
    .from('user_claim_data_locks')
    .insert(claimDataInserts);

  if (insertError) {
    log.error({ error: insertError }, 'Failed to insert focus lock claim data');
    throw new Error(`Failed to insert claim data: ${insertError.message}`);
  }

  logDatabaseOperation('insert_focus_lock_claim_data', claimDataInserts.length);

  log.info('Successfully stored all focus lock results to database');
}

