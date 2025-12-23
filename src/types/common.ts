/**
 * Common types shared across all pool types (alarms, focus locks, etc.)
 */

/**
 * Pool information identifying a specific 12-hour period
 */
export interface PoolInfo {
  day: number; // Unix day (timestamp / 86400)
  period: 0 | 1; // 0 = AM (00:00-11:59), 1 = PM (12:00-23:59)
}

/**
 * Time range for a pool period
 */
export interface PoolTimeRange {
  periodStart: number; // Unix timestamp start of period
  periodEnd: number; // Unix timestamp end of period
}

/**
 * Reward data for a single user
 */
export interface RewardData {
  address: string; // User's wallet address (0x...)
  reward_amount: string; // Reward amount as string (u256)
}

/**
 * Merkle tree with root and proofs for all addresses
 */
export interface MerkleTree {
  root: string; // Merkle root hash (0x...)
  proofs: Record<string, string[]>; // Address -> array of sibling hashes
}

/**
 * U256 value split into low and high parts for Cairo
 */
export interface U256Parts {
  low: string; // Lower 128 bits
  high: string; // Upper 128 bits
}

/**
 * Result of pool processing operation
 */
export interface ProcessingResult {
  success: boolean;
  pool_info?: ProcessedPoolInfo;
  transaction_hash?: string;
  message?: string;
}

/**
 * Detailed information about a processed pool
 */
export interface ProcessedPoolInfo {
  day: number;
  period: 0 | 1;
  merkle_root: string;
  total_slashed_amount: string;
  new_rewards: string;
  protocol_fees: string;
  transaction_hash: string;
  total_users: number;
  winners: number;
  processed_at: string;
  blockchain_status: 'success' | 'failed';
}

/**
 * Base interface for pool users (extended by specific pool types)
 */
export interface BasePoolUser {
  address: string; // Wallet address
  stake_amount: string; // Staked amount in smallest unit (e.g., 6 decimals for USDC)
  uuid: string; // Database UUID
  id: string; // On-chain ID (u64 as string)
}

/**
 * Configuration for a specific pool type contract
 */
export interface PoolContractConfig {
  contract_address: string;
  verifier_private_key: string;
}

