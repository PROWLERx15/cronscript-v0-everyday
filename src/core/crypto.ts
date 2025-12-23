/**
 * SNIP-12 signature generation for outcome verification
 * 
 * Implements SNIP-12 (StarkNet Improvement Proposal 12) signatures
 * for alarm and focus lock claim verification
 */

import { hash, ec, shortString } from 'starknet';
import { AlarmSignature } from '../types/alarm.js';
import { createModuleLogger } from './logger.js';
import { toHexString } from './calculator.js';

const log = createModuleLogger('crypto');

/**
 * Type hashes for SNIP-12 (from alarm contract)
 * 
 * These must match the contract's SNIP12Metadata implementation
 */
const ALARM_CLAIM_REQUEST_TYPE_HASH = BigInt(
  '0x18e6ece967e47a0a2514d06bc44dc82365b0c4dc7b7b3cdf90dc12aca6f139f'
);

const DOMAIN_TYPE_HASH = BigInt(
  '0x36bf5154c31394cfe157e49516c7f229afc34006ac2ab75fb5932786c291f38'
);

/**
 * Create SNIP-12 signature for alarm claim outcome
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
 * Hash computation:
 * 1. struct_hash = poseidon([TYPE_HASH, user, alarm_id, wakeup_time, snooze_count, expiry])
 * 2. domain_hash = poseidon([DOMAIN_TYPE_HASH, name='EverydayApp', version='1'])
 * 3. message_hash = poseidon(['StarkNet Message', domain_hash, user, struct_hash])
 * 4. Sign with STARK curve
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
  _chainId: string,
  privateKey: string
): AlarmSignature {
  // Normalize private key
  let normalizedPrivateKey = privateKey;
  if (!normalizedPrivateKey.startsWith('0x')) {
    normalizedPrivateKey = '0x' + normalizedPrivateKey;
  }

  log.debug(
    {
      user: userAddress,
      alarmId: alarmId.toString(),
      snoozeCount,
      expiry: expiry.toString(),
    },
    'Creating SNIP-12 alarm signature'
  );

  // Step 1: Compute struct hash
  // poseidon([TYPE_HASH, user, alarm_id, wakeup_time, snooze_count, expiry])
  const structHash = hash.computePoseidonHashOnElements([
    ALARM_CLAIM_REQUEST_TYPE_HASH,
    BigInt(userAddress),
    alarmId,
    wakeupTime,
    BigInt(snoozeCount),
    expiry,
  ]);

  // Step 2: Compute domain hash (name + version only, matching SNIP12MetadataImpl)
  // poseidon([DOMAIN_TYPE_HASH, name, version])
  const name = BigInt(shortString.encodeShortString('EverydayApp'));
  const version = BigInt(shortString.encodeShortString('1'));

  const domainHash = hash.computePoseidonHashOnElements([
    DOMAIN_TYPE_HASH,
    name,
    version,
  ]);

  // Step 3: Compute final message hash
  // poseidon(['StarkNet Message', domain_hash, user, struct_hash])
  const PREFIX = BigInt(shortString.encodeShortString('StarkNet Message'));
  const messageHash = hash.computePoseidonHashOnElements([
    PREFIX,
    BigInt(domainHash),
    BigInt(userAddress),
    BigInt(structHash),
  ]);

  // Step 4: Sign with STARK curve
  const messageHashHex = toHexString(messageHash);
  const signature = ec.starkCurve.sign(messageHashHex, normalizedPrivateKey);

  // Get public key
  const publicKey = ec.starkCurve.getStarkKey(normalizedPrivateKey);

  log.debug(
    {
      messageHash: messageHashHex,
      signatureR: toHexString(signature.r),
    },
    'SNIP-12 signature created'
  );

  return {
    message_hash: messageHashHex,
    signature_r: toHexString(signature.r),
    signature_s: toHexString(signature.s),
    public_key: toHexString(publicKey),
  };
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

