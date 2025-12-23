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

