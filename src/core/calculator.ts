/**
 * Pool-agnostic reward calculation and merkle tree generation
 * 
 * This module implements:
 * - Stake return calculation based on penalty/slash count
 * - Reward distribution with protocol fees
 * - Merkle tree generation using Poseidon hashing (Starknet/Cairo compatible)
 * - Helper functions for u256/u64 conversions
 */

import { hash } from 'starknet';
import { RewardData, MerkleTree, U256Parts, BasePoolUser } from '../types/common.js';
import { FocusLockUser, FocusLockReward } from '../types/focus.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('calculator');

/**
 * Penalty percentages for stake slashing
 */
const PERCENT_BASE = 100n;
const SLASH_20_PERCENT = 80n; // Return 80% (20% slashed)
const SLASH_50_PERCENT = 50n; // Return 50% (50% slashed)
const SLASH_100_PERCENT = 0n; // Return 0% (100% slashed)

/**
 * Protocol fee percentage (10%)
 */
const PROTOCOL_FEE_PERCENT = 10n;

/**
 * Calculate stake return based on slash/snooze count
 * 
 * Rules:
 * - slashCount 0: 100% return (no penalty)
 * - slashCount 1: 80% return (20% slashed)
 * - slashCount 2: 50% return (50% slashed)
 * - slashCount 3+: 0% return (100% slashed)
 */
export function calculateStakeReturn(
  stakeAmount: bigint,
  slashCount: number
): bigint {
  switch (slashCount) {
    case 0:
      return stakeAmount;
    case 1:
      return (stakeAmount * SLASH_20_PERCENT) / PERCENT_BASE;
    case 2:
      return (stakeAmount * SLASH_50_PERCENT) / PERCENT_BASE;
    default:
      return SLASH_100_PERCENT;
  }
}

/**
 * Calculate total slashed amount from all users
 */
export function calculateTotalSlashed(
  users: Array<{ stake_amount: string; snooze_count?: number }>
): bigint {
  let totalSlashed = 0n;

  for (const user of users) {
    const stakeAmount = BigInt(user.stake_amount);
    const slashCount = user.snooze_count ?? 0;
    const returnAmount = calculateStakeReturn(stakeAmount, slashCount);
    totalSlashed += stakeAmount - returnAmount;
  }

  log.debug({ totalSlashed: totalSlashed.toString() }, 'Calculated total slashed');
  return totalSlashed;
}

/**
 * Calculate rewards for winners with protocol fee deduction
 * 
 * @param users All users in the pool
 * @param totalPoolReward Total reward pool (existing + new slashes)
 * @returns Array of rewards distributed to winners
 */
export function calculateRewards(
  users: Array<{ address: string; stake_amount: string; snooze_count?: number }>,
  totalPoolReward: bigint
): RewardData[] {
  // Filter winners (no snoozes/slashes)
  const winners = users.filter((u) => (u.snooze_count ?? 0) === 0);

  if (winners.length === 0 || totalPoolReward === 0n) {
    log.info('No winners or empty reward pool');
    return [];
  }

  // Calculate total winner stake
  const totalWinnerStake = winners.reduce(
    (sum, w) => sum + BigInt(w.stake_amount),
    0n
  );

  if (totalWinnerStake === 0n) {
    log.warn('Total winner stake is zero');
    return [];
  }

  // Deduct protocol fee (10%)
  const protocolFee = (totalPoolReward * PROTOCOL_FEE_PERCENT) / PERCENT_BASE;
  const rewardsForWinners = totalPoolReward - protocolFee;

  log.info(
    {
      winners: winners.length,
      totalPoolReward: totalPoolReward.toString(),
      protocolFee: protocolFee.toString(),
      rewardsForWinners: rewardsForWinners.toString(),
    },
    'Calculating rewards distribution'
  );

  // Distribute rewards proportionally by stake
  const rewards: RewardData[] = winners.map((winner) => {
    const winnerStake = BigInt(winner.stake_amount);
    const proportionalReward =
      (rewardsForWinners * winnerStake) / totalWinnerStake;

    return {
      address: winner.address,
      reward_amount: proportionalReward.toString(),
    };
  });

  return rewards;
}

/**
 * Create a merkle leaf hash for a user and their reward
 * Uses Poseidon hashing for Starknet/Cairo compatibility
 * 
 * Leaf structure: poseidon([address, reward.low, reward.high])
 */
export function createMerkleLeaf(
  userAddress: string,
  rewardAmount: bigint
): string {
  const addressFelt = BigInt(userAddress);
  
  // Split u256 into low and high
  const mask128 = (1n << 128n) - 1n;
  const rewardLow = rewardAmount & mask128;
  const rewardHigh = rewardAmount >> 128n;

  const leafHash = hash.computePoseidonHashOnElements([
    addressFelt,
    rewardLow,
    rewardHigh,
  ]);

  return toHexString(leafHash);
}

/**
 * Build merkle tree with proofs for all addresses
 * Uses Poseidon hashing and sorted pairs (OpenZeppelin standard)
 * 
 * IMPORTANT: Cannot use generic merkle libraries as they use SHA-256,
 * but Starknet requires Poseidon hashing
 * 
 * @param leaves Array of {address, hash} objects
 * @returns Merkle tree with root and proofs for all addresses
 */
export function buildMerkleTree(
  leaves: Array<{ address: string; hash: string }>
): MerkleTree {
  if (leaves.length === 0) {
    // Generate a valid non-zero merkle root for empty reward case
    const noRewardsHash = hash.computePoseidonHashOnElements([
      BigInt('0x6e6f5f726577617264734040'), // "no_rewards@@"
    ]);
    log.info('Built empty merkle tree');
    return { root: toHexString(noRewardsHash), proofs: {} };
  }

  if (leaves.length === 1) {
    log.info('Built single-leaf merkle tree');
    return { root: leaves[0]!.hash, proofs: { [leaves[0]!.address]: [] } };
  }

  const proofs: Record<string, string[]> = {};
  leaves.forEach((leaf) => (proofs[leaf.address] = []));

  // Build tree level by level
  let currentLevel = leaves.map((l) => ({
    addresses: [l.address],
    hashBig: BigInt(l.hash),
  }));

  while (currentLevel.length > 1) {
    const nextLevel = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1]! : left;

      // Add sibling hash to proofs for ALL addresses in left node
      for (const addr of left.addresses) {
        proofs[addr]!.push(toHexString(right.hashBig));
      }

      // Add sibling hash to proofs for ALL addresses in right node (if different)
      if (left !== right) {
        for (const addr of right.addresses) {
          proofs[addr]!.push(toHexString(left.hashBig));
        }
      }

      // Compute parent hash using sorted pairs (OpenZeppelin standard)
      const [sortedA, sortedB] =
        left.hashBig < right.hashBig
          ? [left.hashBig, right.hashBig]
          : [right.hashBig, left.hashBig];

      const parentHashBig = hash.computePoseidonHashOnElements([
        sortedA,
        sortedB,
      ]);

      // Parent node contains addresses from both children
      const parentAddresses = [
        ...left.addresses,
        ...(left !== right ? right.addresses : []),
      ];
      nextLevel.push({ addresses: parentAddresses, hashBig: BigInt(parentHashBig.toString()) });
    }

    currentLevel = nextLevel;
  }

  const root = toHexString(currentLevel[0]!.hashBig);
  log.info(
    { root, leafCount: leaves.length, proofCount: Object.keys(proofs).length },
    'Built merkle tree'
  );

  return { root, proofs };
}

/**
 * Aggregate rewards by unique address (handle multiple entries per user)
 */
export function aggregateRewardsByAddress(
  rewards: RewardData[]
): Map<string, bigint> {
  const aggregated = new Map<string, bigint>();

  for (const reward of rewards) {
    const existing = aggregated.get(reward.address) ?? 0n;
    aggregated.set(reward.address, existing + BigInt(reward.reward_amount));
  }

  return aggregated;
}

/**
 * Validate pool users data (types and ranges)
 */
export function validatePoolUsers(
  users: Array<BasePoolUser>
): void {
  for (const user of users) {
    // Validate address format
    if (!user.address || !user.address.startsWith('0x')) {
      throw new Error(`Invalid address: ${user.address}`);
    }

    // Validate stake amount (u256)
    const stakeAmount = BigInt(user.stake_amount);
    if (stakeAmount < 0n || stakeAmount >= 1n << 256n) {
      throw new Error(
        `stake_amount out of u256 range: ${user.stake_amount}`
      );
    }
  }

  log.debug({ userCount: users.length }, 'Validated pool users');
}

/**
 * Convert value to u256 parts (low, high)
 */
export function toU256Parts(val: bigint): U256Parts {
  const low = val & ((1n << 128n) - 1n);
  const high = val >> 128n;
  return {
    low: low.toString(),
    high: high.toString(),
  };
}

/**
 * Normalize value to u64 (for IDs)
 */
export function normalizeToU64(val: string | bigint): bigint {
  const mask64 = (1n << 64n) - 1n;
  const n = BigInt(val);
  return n & mask64;
}

/**
 * Convert value to hex string
 */
export function toHexString(val: bigint | string): string {
  if (typeof val === 'string' && val.startsWith('0x')) {
    return val.toLowerCase();
  }
  return '0x' + BigInt(val).toString(16);
}

/**
 * Convert hex string or number to bigint
 */
export function toBigInt(val: string | number | bigint): bigint {
  if (typeof val === 'bigint') {
    return val;
  }
  return BigInt(val);
}

// ========================================
// Focus Lock Specific Functions
// ========================================

/**
 * Calculate user weight for focus locks (stake × duration)
 * Higher stake and longer duration result in higher weight
 */
export function calculateFocusUserWeight(
  stakeAmount: bigint,
  duration: bigint
): bigint {
  return stakeAmount * duration;
}

/**
 * Calculate total slashed amount from all focus locks
 */
export function calculateFocusTotalSlashed(
  users: FocusLockUser[]
): bigint {
  let totalSlashed = 0n;

  for (const user of users) {
    const stakeAmount = BigInt(user.stake_amount);
    if (!user.completion_status) {
      // Failed/exited early - 100% slashed
      totalSlashed += stakeAmount;
    }
    // Successful locks contribute 0 to slashed amount
  }

  log.debug({ totalSlashed: totalSlashed.toString() }, 'Calculated focus total slashed');
  return totalSlashed;
}

/**
 * Calculate rewards for focus locks with weighted distribution
 * Rewards are distributed proportionally based on stake × duration per lock
 * Each lock gets its own reward based on its individual weight
 */
export function calculateFocusRewards(
  users: FocusLockUser[],
  totalPoolReward: bigint
): FocusLockReward[] {
  // Filter winners (completed successfully)
  const winners = users.filter((u) => u.completion_status === true);

  if (winners.length === 0 || totalPoolReward === 0n) {
    log.info('No focus lock winners or empty reward pool');
    return [];
  }

  // Calculate weighted scores for all winning locks
  const winnersWithWeights = winners.map((winner) => {
    const stakeAmount = BigInt(winner.stake_amount);
    const duration = BigInt(winner.duration);
    const weight = calculateFocusUserWeight(stakeAmount, duration);

    return {
      ...winner,
      weight,
    };
  });

  const totalWinnerWeight = winnersWithWeights.reduce(
    (sum, w) => sum + w.weight,
    0n
  );

  if (totalWinnerWeight === 0n) {
    log.warn('Total winner weight is zero');
    return [];
  }

  // Deduct protocol fee (10%)
  const protocolFee = (totalPoolReward * PROTOCOL_FEE_PERCENT) / PERCENT_BASE;
  const rewardsForWinners = totalPoolReward - protocolFee;

  log.info(
    {
      winners: winners.length,
      totalPoolReward: totalPoolReward.toString(),
      protocolFee: protocolFee.toString(),
      rewardsForWinners: rewardsForWinners.toString(),
      totalWinnerWeight: totalWinnerWeight.toString(),
    },
    'Calculating focus lock rewards (weighted by stake × duration)'
  );

  // Each lock gets its own reward based on individual weight
  const rewards: FocusLockReward[] = winnersWithWeights.map((winner) => {
    const proportionalReward = (rewardsForWinners * winner.weight) / totalWinnerWeight;

    return {
      address: winner.address,
      session_id: winner.session_id,
      reward_amount: proportionalReward.toString(),
      weight: winner.weight.toString(),
      stake_amount: winner.stake_amount,
      duration: winner.duration.toString(),
    };
  });

  return rewards;
}

/**
 * Create a merkle leaf hash for a focus lock with session_id
 *
 * Leaf structure: poseidon([address, session_id, reward.low, reward.high])
 */
export function createFocusMerkleLeaf(
  userAddress: string,
  sessionId: bigint,
  rewardAmount: bigint
): string {
  const addressFelt = BigInt(userAddress);
  const sessionIdFelt = BigInt(sessionId);

  // Split u256 into low and high
  const mask128 = (1n << 128n) - 1n;
  const rewardLow = rewardAmount & mask128;
  const rewardHigh = rewardAmount >> 128n;

  const leafHash = hash.computePoseidonHashOnElements([
    addressFelt,
    sessionIdFelt,
    rewardLow,
    rewardHigh,
  ]);

  return toHexString(leafHash);
}

/**
 * Build focus lock merkle tree with proofs for all locks
 * Uses Poseidon hashing and sorted pairs (OpenZeppelin standard)
 *
 * Each leaf is keyed by "address_sessionid" for unique identification
 *
 * @param leaves Array of {address, session_id, hash} objects
 * @returns Merkle tree with root and proofs keyed by "address_sessionid"
 */
export function buildFocusMerkleTree(
  leaves: Array<{ address: string; session_id: bigint; hash: string }>
): MerkleTree {
  if (leaves.length === 0) {
    const noRewardsHash = hash.computePoseidonHashOnElements([
      BigInt('0x6e6f5f726577617264734040'), // "no_rewards@@"
    ]);
    log.info('Built empty focus merkle tree');
    return { root: toHexString(noRewardsHash), proofs: {} };
  }

  if (leaves.length === 1) {
    const key = `${leaves[0]!.address}_${leaves[0]!.session_id}`;
    log.info('Built single-leaf focus merkle tree');
    return { root: leaves[0]!.hash, proofs: { [key]: [] } };
  }

  const proofs: Record<string, string[]> = {};
  leaves.forEach((leaf) => {
    const key = `${leaf.address}_${leaf.session_id}`;
    proofs[key] = [];
  });

  // Track all descendant leaf keys for each node
  let currentLevel = leaves.map((l) => {
    const key = `${l.address}_${l.session_id}`;
    return {
      hashBig: BigInt(l.hash),
      leafKeys: [key], // Track which leaves are descendants
    };
  });

  while (currentLevel.length > 1) {
    const nextLevel = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1]! : left;

      // For all leaves in left's subtree, add right's hash to proof
      for (const leafKey of left.leafKeys) {
        proofs[leafKey]!.push(toHexString(right.hashBig));
      }

      // For all leaves in right's subtree, add left's hash to proof
      if (left !== right) {
        for (const leafKey of right.leafKeys) {
          if (!left.leafKeys.includes(leafKey)) {
            proofs[leafKey]!.push(toHexString(left.hashBig));
          }
        }
      }

      // Compute parent hash using sorted pairs (OpenZeppelin standard)
      const [sortedA, sortedB] =
        left.hashBig < right.hashBig
          ? [left.hashBig, right.hashBig]
          : [right.hashBig, left.hashBig];

      const parentHashBig = hash.computePoseidonHashOnElements([
        sortedA,
        sortedB,
      ]);

      // Combine leaf keys from both children
      const combinedLeafKeys = [...left.leafKeys];
      if (left !== right) {
        for (const key of right.leafKeys) {
          if (!combinedLeafKeys.includes(key)) {
            combinedLeafKeys.push(key);
          }
        }
      }

      nextLevel.push({
        hashBig: BigInt(parentHashBig.toString()),
        leafKeys: combinedLeafKeys,
      });
    }

    currentLevel = nextLevel;
  }

  const root = toHexString(currentLevel[0]!.hashBig);
  log.info(
    {
      root,
      leafCount: leaves.length,
      proofCount: Object.keys(proofs).length,
    },
    'Built focus lock merkle tree'
  );

  return { root, proofs };
}

