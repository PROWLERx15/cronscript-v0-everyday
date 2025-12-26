/**
 * Alarm-specific types for alarm pool processing
 */

import { BasePoolUser, PoolContractConfig } from './common.js';

/**
 * Alarm user data from database
 */
export interface AlarmUser extends BasePoolUser {
  wake_up_time: string; // Unix timestamp as string
  snooze_count: number; // Number of snoozes (0 = winner, 1+ = loser)
  alarm_uuid: string; // Database UUID (same as uuid)
  alarm_id: string; // On-chain alarm ID as u64 string (same as id)
}

/**
 * Alarm claim data stored in database
 */
export interface AlarmClaimData {
  alarm_id: string; // Foreign key to alarm UUID
  signature_r: string; // SNIP-12 signature r component
  signature_s: string; // SNIP-12 signature s component
  message_hash: string; // SNIP-12 message hash
  reward_amount: string; // Reward amount for this user
  merkle_proof: string; // JSON string of merkle proof array
  expiry_time: number; // Signature expiry timestamp (48h from processing)
  processed_at: string; // ISO timestamp when processed
}

/**
 * Alarm pool configuration
 */
export interface AlarmPoolConfig extends PoolContractConfig {
  contract_address: string;
  verifier_private_key: string;
}

/**
 * SNIP-12 signature result for alarm claim
 */
export interface AlarmSignature {
  message_hash: string;
  signature_r: string;
  signature_s: string;
  public_key: string;
}

/**
 * Database alarm record structure (subset of fields)
 */
export interface DatabaseAlarmRecord {
  id: string; // UUID
  user_id: string;
  wakeup_time: number;
  stake_amount: number; // USDC with 2 decimals (e.g., 50.00)
  snooze_count: number;
  alarm_id: bigint | null; // On-chain ID
  deleted: boolean;
  claim_ready: boolean;
  has_claimed: boolean;
}

/**
 * Parameters for batch alarm updates
 */
export interface AlarmBatchUpdate {
  id: string; // UUID
  claim_ready: boolean;
  has_claimed: boolean;
}

/**
 * Parameters for claim data insert
 */
export interface ClaimDataInsert {
  alarm_id: string; // UUID foreign key
  signature_r: string;
  signature_s: string;
  message_hash: string;
  reward_amount: string;
  merkle_proof: string; // JSON string
  expiry_time: number;
  processed_at: string;
}

