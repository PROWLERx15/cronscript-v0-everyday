/**
 * SNIP-12 signature generation for outcome verification
 *
 * Implements SNIP-12 (StarkNet Improvement Proposal 12) signatures
 * for alarm and focus lock claim verification
 *
 * VERIFIED IMPLEMENTATION: This matches the tested signature generation
 * that produces valid signatures for the Cairo contract.
 */

import { hash, ec, shortString } from 'starknet';
import { AlarmSignature } from '../types/alarm.js';
import { createModuleLogger } from './logger.js';
import { toHexString } from './calculator.js';

const log = createModuleLogger('crypto');

/**
 * Type hashes for SNIP-12 (from snip12.cairo and alarm.cairo)
 *
 * These must match the contract's SNIP12Metadata implementation exactly
 */

// SNIP-12 Domain Type Hash (from snip12.cairo)
const STARKNET_DOMAIN_TYPE_HASH = BigInt(
  '0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210'
);

// ClaimRequest Type Hash (from alarm.cairo)
const CLAIM_REQUEST_TYPE_HASH = BigInt(
  '0x18e6ece967e47a0a2514d06bc44dc82365b0c4dc7b7b3cdf90dc12aca6f139f'
);

/**
 * Create SNIP-12 signature for alarm claim outcome
 *
 * VERIFIED: This implementation matches the tested and working JS signature generation.
 *
 * Signature structure matches contract's ClaimRequest:
 * struct ClaimRequest {
 *   user: ContractAddress,
 *   alarm_id: u64,
 *   wakeup_time: u64,
 *   snooze_count: u8,
 *   expiry: u64
 * }
 *
 * Hash computation (SNIP-12 compliant):
 * 1. domain_hash = poseidon([STARKNET_DOMAIN_TYPE_HASH, name, version, chainId, revision])
 * 2. struct_hash = poseidon([CLAIM_REQUEST_TYPE_HASH, user, alarm_id, wakeup_time, snooze_count, expiry])
 * 3. message_hash = poseidon(['StarkNet Message', domain_hash, user, struct_hash])
 * 4. Sign with STARK curve using raw hex (no 0x prefix)
 *
 * @returns Signature components (r, s, message_hash, public_key)
 */
export function createAlarmOutcomeSignature(
  userAddress: string,
  alarmId: bigint,
  wakeupTime: bigint,
  snoozeCount: number,
  expiry: bigint,
  _contractAddress: string,
  chainId: string,
  privateKey: string
): AlarmSignature {
  // Log all signature inputs for debugging
  log.info(
    {
      user: userAddress,
      alarmId: alarmId.toString(),
      wakeupTime: wakeupTime.toString(),
      wakeupTimeDate: new Date(Number(wakeupTime) * 1000).toISOString(),
      snoozeCount,
      expiry: expiry.toString(),
      expiryDate: new Date(Number(expiry) * 1000).toISOString(),
      chainId,
    },
    '🔐 Creating SNIP-12 alarm signature - INPUTS'
  );

  // Step 1: Compute domain hash (matching SNIP-12 with chainId and revision)
  // poseidon([STARKNET_DOMAIN_TYPE_HASH, name, version, chainId, revision])
  const domainHash = hash.computePoseidonHashOnElements([
    STARKNET_DOMAIN_TYPE_HASH,
    BigInt(shortString.encodeShortString('EverydayApp')),
    BigInt(shortString.encodeShortString('1')),
    BigInt(chainId), // Chain ID (e.g., SN_SEPOLIA hex)
    BigInt(1), // revision
  ]);

  // Step 2: Compute struct hash
  // poseidon([CLAIM_REQUEST_TYPE_HASH, user, alarm_id, wakeup_time, snooze_count, expiry])
  const structHash = hash.computePoseidonHashOnElements([
    CLAIM_REQUEST_TYPE_HASH,
    BigInt(userAddress),
    alarmId,
    wakeupTime,
    BigInt(snoozeCount),
    expiry,
  ]);

  // Step 3: Compute final message hash (SNIP-12)
  // poseidon(['StarkNet Message', domain_hash, user, struct_hash])
  const messageHash = hash.computePoseidonHashOnElements([
    BigInt(shortString.encodeShortString('StarkNet Message')),
    BigInt(domainHash),
    BigInt(userAddress),
    BigInt(structHash),
  ]);

  // Step 4: Prepare message hash for signing
  // CRITICAL: Pad to 64 chars (32 bytes) and ensure no 0x prefix for signing
  let msgHex = BigInt(messageHash).toString(16);
  msgHex = msgHex.padStart(64, '0');

  // Clean private key - remove 0x prefix for signing
  let privKeyClean = privateKey;
  if (privKeyClean.startsWith('0x')) {
    privKeyClean = privKeyClean.slice(2);
  }

  log.debug(
    {
      domainHash: toHexString(domainHash),
      structHash: toHexString(structHash),
      messageHash: `0x${msgHex}`,
    },
    'SNIP-12 hash components computed'
  );

  // Step 5: Sign with STARK curve using raw hex
  const signature = ec.starkCurve.sign(msgHex, privKeyClean);

  // Get public key (needs 0x prefix for this call)
  const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const publicKey = ec.starkCurve.getStarkKey(normalizedPrivateKey);

  const result = {
    message_hash: `0x${msgHex}`,
    signature_r: toHexString(signature.r),
    signature_s: toHexString(signature.s),
    public_key: toHexString(publicKey),
  };

  // Log the complete signature output
  log.info(
    {
      user: userAddress,
      alarmId: alarmId.toString(),
      wakeupTime: wakeupTime.toString(),
      snoozeCount,
      expiry: expiry.toString(),
      chainId,
      messageHash: result.message_hash,
      signatureR: result.signature_r,
      signatureS: result.signature_s,
      publicKey: result.public_key,
    },
    '✅ SNIP-12 signature created - FULL OUTPUT'
  );

  return result;
}

/**
 * Placeholder for focus lock SNIP-12 signature
 * 
 * TODO: Implement when focus lock processing is added
 * Will have similar structure but different type hash and struct fields
 */
export function createFocusOutcomeSignature(
  // Parameters TBD based on focus lock contract
  ..._args: unknown[]
): unknown {
  throw new Error('Focus lock signatures not yet implemented');
}

/**
 * Calculate expiry timestamp (48 hours from now)
 */
export function calculateExpiry(): number {
  const now = Math.floor(Date.now() / 1000);
  const EXPIRY_DURATION = 48 * 60 * 60; // 48 hours
  return now + EXPIRY_DURATION;
}

