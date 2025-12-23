/**
 * Focus lock-specific types (placeholder for future implementation)
 * 
 * When implementing focus locks, add types similar to alarm.ts:
 * - FocusLockUser extends BasePoolUser
 * - FocusLockClaimData
 * - FocusLockPoolConfig
 * - FocusLockSignature
 * - Database record types
 */

import { BasePoolUser, PoolContractConfig } from './common.js';

/**
 * Placeholder for focus lock user
 * TODO: Implement when focus lock processing is added
 */
export interface FocusLockUser extends BasePoolUser {
  // Add focus-specific fields here
  // e.g., lock_start_time, lock_duration, completion_status, etc.
}

/**
 * Placeholder for focus lock config
 * TODO: Implement when focus lock processing is added
 */
export interface FocusLockPoolConfig extends PoolContractConfig {
  contract_address: string;
  verifier_private_key: string;
}

