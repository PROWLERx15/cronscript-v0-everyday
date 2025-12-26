/**
 * Main focus lock pool processor
 * 
 * Processes a single focus lock pool through the complete flow:
 * 1. Fetch focus locks from database
 * 2. Validate user data
 * 3. Calculate rewards (weighted by stake × duration)
 * 4. Build merkle tree with session_id
 * 5. Set merkle root on-chain (CRITICAL - must succeed!)
 * 6. Store results to database
 */

import { ProcessingResult } from '../types/common.js';
import { getFocusConfig, getCoreConfig } from '../core/config.js';
import {
  fetchFocusLocksFromPool,
  storeFocusLockResults,
  calculateTimeRange,
} from '../core/database.js';
import {
  calculateFocusTotalSlashed,
  calculateFocusRewards,
  buildFocusMerkleTree,
  createFocusMerkleLeaf,
  validatePoolUsers,
} from '../core/calculator.js';
import { calculateExpiry } from '../core/crypto.js';
import { getBlockchainService } from '../core/blockchain.js';
import {
  createModuleLogger,
  logPoolProcessingStart,
  logPoolProcessingSuccess,
  logPoolProcessingFailure,
} from '../core/logger.js';

const log = createModuleLogger('focus-processor');

/**
 * Time buffer after period end before processing (30 minutes)
 */
const TIME_BUFFER_SECONDS = 30 * 60;

/**
 * Protocol fee percentage (10%)
 */
const PROTOCOL_FEE_PERCENT = 10n;
const PERCENT_BASE = 100n;

/**
 * Process a single focus lock pool
 * 
 * @param day Unix day
 * @param period 0=AM, 1=PM
 * @param force Skip time buffer check
 * @returns Processing result
 */
export async function processFocusLockPool(
  day: number,
  period: 0 | 1,
  force = false
): Promise<ProcessingResult> {
  logPoolProcessingStart(day, period);

  try {
    // Check if focus config is available
    const focusConfig = getFocusConfig();
    if (!focusConfig) {
      throw new Error(
        'Focus lock configuration not available. Set FOCUS_CONTRACT_ADDRESS and FOCUS_VERIFIER_PRIVATE_KEY in .env'
      );
    }

    // Check time buffer (unless forced)
    if (!force) {
      const now = Math.floor(Date.now() / 1000);
      const { periodEnd } = calculateTimeRange(day, period);
      const readyTime = periodEnd + TIME_BUFFER_SECONDS;

      if (now < readyTime) {
        const delta = readyTime - now;
        const readyDate = new Date(readyTime * 1000);
        
        log.warn(
          {
            pool: { day, period },
            now,
            readyTime,
            deltaSeconds: delta,
            readyDate: readyDate.toISOString(),
          },
          'Too early to process focus lock pool'
        );

        return {
          success: false,
          message: `Too early to process. Pool will be ready in ${delta}s at ${readyDate.toISOString()}`,
        };
      }
    } else {
      log.warn({ pool: { day, period } }, 'Forcing focus lock pool processing (buffer check skipped)');
    }

    // Step 1: Fetch focus locks from database
    log.info('Step 1: Fetching focus locks from database');
    const users = await fetchFocusLocksFromPool(day, period);

    if (users.length === 0) {
      log.warn({ pool: { day, period } }, 'No focus locks found in pool');
      return {
        success: false,
        message: 'No focus locks in pool',
      };
    }

    // Step 2: Validate user data
    log.info({ lockCount: users.length }, 'Step 2: Validating focus lock data');
    validatePoolUsers(users);
    log.info('All focus lock data validated successfully');

    // Step 3: Calculate rewards (weighted by stake × duration)
    log.info('Step 3: Calculating rewards (weighted by stake × duration)');
    
    const totalSlashed = calculateFocusTotalSlashed(users);
    const protocolFees = (totalSlashed * PROTOCOL_FEE_PERCENT) / PERCENT_BASE;
    const newRewards = totalSlashed - protocolFees; // 90% to winners

    const rewards = calculateFocusRewards(users, newRewards);

    log.info(
      {
        totalSlashed: totalSlashed.toString(),
        protocolFees: protocolFees.toString(),
        newRewards: newRewards.toString(),
        winnerCount: rewards.length,
        totalLocks: users.length,
      },
      'Focus lock rewards calculated'
    );

    // Log weighted distribution details
    if (rewards.length > 0) {
      log.info('Weighted distribution details (per lock):');
      rewards.forEach((reward, index) => {
        const weight = BigInt(reward.weight);
        const stake = BigInt(reward.stake_amount);
        const duration = BigInt(reward.duration);
        const rewardAmount = BigInt(reward.reward_amount);

        log.info(
          {
            lock: index + 1,
            address: reward.address.slice(0, 10) + '...',
            sessionId: reward.session_id.toString(),
            stakeSTRK: (Number(stake) / 1e18).toFixed(2),
            durationHours: (Number(duration) / 3600).toFixed(1),
            weight: weight.toString(),
            rewardSTRK: (Number(rewardAmount) / 1e18).toFixed(2),
          },
          'Winner lock distribution'
        );
      });
    }

    // Step 4: Build merkle tree (includes session_id in leaves)
    log.info('Step 4: Building merkle tree with session IDs');

    // Build leaves with one entry per lock (keyed by address_sessionid)
    const leaves = users.map((user) => {
      const userReward = rewards.find(
        (r) => r.address === user.address && BigInt(r.session_id) === user.session_id
      );
      const rewardAmount = userReward ? BigInt(userReward.reward_amount) : 0n;
      
      return {
        address: user.address,
        session_id: user.session_id,
        hash: createFocusMerkleLeaf(user.address, user.session_id, rewardAmount),
      };
    });

    const merkleTree = buildFocusMerkleTree(leaves);

    log.info(
      {
        merkleRoot: merkleTree.root,
        leafCount: leaves.length,
        proofCount: Object.keys(merkleTree.proofs).length,
        winners: rewards.length,
        nonWinners: users.length - rewards.length,
      },
      'Merkle tree built with session IDs'
    );

    // Step 5: Set merkle root on-chain (CRITICAL!)
    log.info('Step 5: Setting merkle root on-chain');
    
    const blockchainService = getBlockchainService();
    await blockchainService.initialize();

    let txHash: string;
    try {
      txHash = await blockchainService.setMerkleRootOnChain(
        focusConfig.contract_address,
        day,
        period,
        merkleTree.root,
        newRewards,
        protocolFees
      );
      
      log.info({ txHash }, 'Focus lock merkle root set on-chain successfully');
    } catch (error) {
      log.error(
        { error, pool: { day, period } },
        'CRITICAL: Blockchain transaction failed'
      );
      throw new Error(
        `Blockchain finalization required before database storage: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Step 6: Store results to database (only after blockchain success!)
    log.info('Step 6: Storing results to database');
    
    const { starknetChainId } = getCoreConfig();
    const expiry = calculateExpiry();

    await storeFocusLockResults(
      users,
      rewards,
      merkleTree,
      focusConfig,
      starknetChainId,
      expiry
    );

    log.info('Focus lock results stored to database successfully');

    // Success!
    const processedAt = new Date().toISOString();
    
    logPoolProcessingSuccess(day, period, txHash, users.length, rewards.length);

    return {
      success: true,
      pool_info: {
        day,
        period,
        merkle_root: merkleTree.root,
        total_slashed_amount: totalSlashed.toString(),
        new_rewards: newRewards.toString(),
        protocol_fees: protocolFees.toString(),
        transaction_hash: txHash,
        total_users: users.length,
        winners: rewards.length,
        processed_at: processedAt,
        blockchain_status: 'success',
      },
      transaction_hash: txHash,
    };
  } catch (error) {
    logPoolProcessingFailure(day, period, error as Error);
    throw error;
  }
}
