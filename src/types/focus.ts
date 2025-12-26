/**
 * Focus lock-specific types for pool processing
 */

import { BasePoolUser, PoolContractConfig } from './common.js';

/**
 * Focus lock user data from database
 */
export interface FocusLockUser extends BasePoolUser {
  session_id: bigint; // On-chain lock ID (from focus_locks.lock_id)
  start_time: bigint; // Lock start timestamp
  duration: bigint; // Lock duration in seconds
  completion_status: boolean; // Whether the lock was completed successfully
  focus_lock_id: string; // UUID from focus_locks.id for database relations
}

/**
 * Database record from focus_locks table
 */
export interface DatabaseFocusLockRecord {
  id: string; // UUID
  user_id: string;
  habit_name: string;
  duration_minutes: number;
  stake_amount: string; // NUMERIC in DB (STRK)
  start_time: number; // bigint in DB
  end_time: number;
  completion_status: boolean | null;
  is_active: boolean;
  claim_ready: boolean;
  has_claimed: boolean;
  blockchain_stake_tx_hash: string | null;
  blockchain_claim_tx_hash: string | null;
  day: number;
  period: number; // 0-1 for 12-hour periods
  created_at: string;
  updated_at: string;
  lock_id: number | null; // On-chain lock ID (bigint)
}

/**
 * Focus lock signature components (SNIP-12)
 */
export interface FocusLockSignature {
  message_hash: string;
  signature_r: string;
  signature_s: string;
  public_key: string;
}

/**
 * Focus lock claim data for database storage
 */
export interface FocusLockClaimData {
  focus_lock_id: string; // UUID from focus_locks.id
  signature_r: string;
  signature_s: string;
  message_hash: string;
  reward_amount: string;
  merkle_proof: string; // JSON stringified array
  expiry_time: number;
  processed_at: string;
}

/**
 * Focus lock pool configuration
 */
export interface FocusLockPoolConfig extends PoolContractConfig {
  contract_address: string;
  verifier_private_key: string;
}

/**
 * Focus lock reward calculation result
 */
export interface FocusLockReward {
  address: string;
  session_id: bigint;
  reward_amount: string;
  weight: string; // stake_amount * duration
  stake_amount: string;
  duration: string;
}

