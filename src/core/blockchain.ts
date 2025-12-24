/**
 * Blockchain operations for Starknet
 * 
 * Handles:
 * - Starknet RPC provider initialization
 * - AVNU Paymaster for sponsored transactions
 * - Setting merkle roots on-chain
 * - Transaction verification
 */

import { Account, RpcProvider, Call } from 'starknet';
import { getCoreConfig } from './config.js';
import { createModuleLogger, logBlockchainTransaction } from './logger.js';
import { toU256Parts } from './calculator.js';

const log = createModuleLogger('blockchain');

/**
 * Blockchain service for managing Starknet transactions
 */
export class BlockchainService {
  private provider: RpcProvider | null = null;
  private account: Account | null = null;
  private initialized = false;

  /**
   * Initialize Starknet provider and account
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    log.info('Initializing blockchain service');

    const config = getCoreConfig();

    // Initialize Starknet RPC provider
    // Use 'latest' as blockIdentifier for Alchemy compatibility
    this.provider = new RpcProvider({
      nodeUrl: config.starknetRpcUrl,
      // chainId will be auto-detected
    });

    log.info({ rpcUrl: config.starknetRpcUrl }, 'Starknet provider initialized');

    // Initialize account for starknet.js v9
    // The Account class takes an options object
    this.account = new Account({
      provider: this.provider,
      address: config.deployerAddress,
      signer: config.deployerPrivateKey,
    });

    log.info(
      { address: config.deployerAddress },
      'Deployer account initialized'
    );

    this.initialized = true;
    log.info('Blockchain service fully initialized');
  }

  /**
   * Ensure service is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.provider || !this.account) {
      throw new Error('Blockchain service not initialized. Call initialize() first.');
    }
  }

  /**
   * Set merkle root on-chain for a pool
   * 
   * Contract call: set_merkle_root_for_pool(day, period, merkle_root, new_rewards, protocol_fees)
   * 
   * Transaction flow:
   * 1. Prepare contract call
   * 2. Try with regular transaction (no paymaster for now)
   * 3. Wait for confirmation
   * 4. Verify merkle root was set correctly
   * 
   * @returns Transaction hash
   */
  async setMerkleRootOnChain(
    contractAddress: string,
    day: number,
    period: 0 | 1,
    merkleRoot: string,
    newRewards: bigint,
    protocolFees: bigint
  ): Promise<string> {
    this.ensureInitialized();

    log.info(
      {
        pool: { day, period },
        merkleRoot,
        newRewards: newRewards.toString(),
        protocolFees: protocolFees.toString(),
        contractAddress,
      },
      'Setting merkle root on-chain'
    );

    // Split u256 values into low/high parts
    const newRewardsParts = toU256Parts(newRewards);
    const protocolFeesParts = toU256Parts(protocolFees);

    // Prepare contract call
    const call: Call = {
      contractAddress,
      entrypoint: 'set_merkle_root_for_pool',
      calldata: [
        day.toString(),
        period.toString(),
        merkleRoot,
        newRewardsParts.low,
        newRewardsParts.high,
        protocolFeesParts.low,
        protocolFeesParts.high,
      ],
    };

    log.debug({ call }, 'Prepared contract call');

    try {
      // Get nonce explicitly (starknet.js v9 API)
      const nonce = await this.account!.getNonce();
      
      log.debug({ nonce }, 'Got account nonce');

      // Execute transaction with starknet.js v9 API
      // execute(calls, details?) - details include nonce and fee settings
      const result = await this.account!.execute([call], {
        nonce,
      });

      const txHash = result.transaction_hash;
      
      logBlockchainTransaction('set_merkle_root', txHash, {
        pool: { day, period },
      });

      // Wait for confirmation
      log.info({ txHash }, 'Waiting for transaction confirmation');
      
      const receipt = await this.provider!.waitForTransaction(txHash);

      if ('execution_status' in receipt && receipt.execution_status !== 'SUCCEEDED') {
        throw new Error(
          `Transaction failed with status: ${receipt.execution_status}`
        );
      }

      log.info({ txHash }, 'Transaction confirmed on-chain');

      // Verify merkle root was set correctly
      await this.verifyMerkleRoot(contractAddress, day, period, merkleRoot);

      log.info(
        {
          txHash,
          pool: { day, period },
          merkleRoot,
        },
        'Merkle root set successfully'
      );

      return txHash;
    } catch (error) {
      log.error(
        {
          error,
          pool: { day, period },
          contractAddress,
        },
        'Failed to set merkle root on-chain'
      );
      throw error;
    }
  }

  /**
   * Verify merkle root was set correctly on-chain
   */
  private async verifyMerkleRoot(
    contractAddress: string,
    day: number,
    period: 0 | 1,
    expectedMerkleRoot: string
  ): Promise<void> {
    this.ensureInitialized();

    log.debug(
      { pool: { day, period }, expectedMerkleRoot },
      'Verifying merkle root on-chain'
    );

    try {
      const poolInfo = await this.provider!.callContract({
        contractAddress,
        entrypoint: 'get_pool_info',
        calldata: [day.toString(), period.toString()],
      });

      // Response format: (merkle_root, is_finalized, pool_reward, user_count, total_staked)
      const resultArray = Array.isArray(poolInfo) ? poolInfo : (poolInfo as any).result ?? poolInfo;
      const onChainMerkleRoot = this.normalizeHex(resultArray[0]);
      const expectedNormalized = this.normalizeHex(expectedMerkleRoot);

      if (onChainMerkleRoot !== expectedNormalized) {
        throw new Error(
          `Merkle root verification failed! On-chain: ${onChainMerkleRoot}, Expected: ${expectedNormalized}`
        );
      }

      log.info(
        { pool: { day, period }, merkleRoot: onChainMerkleRoot },
        'Merkle root verified on-chain'
      );
    } catch (error) {
      log.error(
        { error, pool: { day, period } },
        'Merkle root verification failed'
      );
      throw error;
    }
  }

  /**
   * Normalize hex string for comparison
   */
  private normalizeHex(hex: string | bigint): string {
    if (typeof hex === 'string') {
      return hex.toLowerCase();
    }
    return '0x' + hex.toString(16).toLowerCase();
  }
}

/**
 * Singleton instance
 */
let blockchainService: BlockchainService | null = null;

/**
 * Get blockchain service instance
 */
export function getBlockchainService(): BlockchainService {
  if (!blockchainService) {
    blockchainService = new BlockchainService();
  }
  return blockchainService;
}

