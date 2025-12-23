/**
 * Environment configuration with Zod validation
 * 
 * Validates all required environment variables on startup
 * and provides typed configuration objects
 */

import { z } from 'zod';
import dotenv from 'dotenv';
import { constants } from 'starknet';
import { AlarmPoolConfig } from '../types/alarm.js';
import { FocusLockPoolConfig } from '../types/focus.js';

// Load environment variables
dotenv.config();

/**
 * Core blockchain configuration schema
 */
const coreConfigSchema = z.object({
  // Database
  SUPABASE_URL: z.string().url('Invalid Supabase URL'),
  SUPABASE_SERVICE_KEY: z.string().min(1, 'Supabase service key is required'),

  // Blockchain
  STARKNET_RPC_URL: z.string().url('Invalid Starknet RPC URL'),
  STARKNET_CHAIN_ID: z
    .string()
    .optional()
    .default('SN_SEPOLIA')
    .transform((val) => {
      // Convert string to actual chain ID constant
      if (val === 'SN_SEPOLIA') return constants.StarknetChainId.SN_SEPOLIA;
      if (val === 'SN_MAIN') return constants.StarknetChainId.SN_MAIN;
      return val;
    }),

  // AVNU Paymaster (optional for sponsored transactions)
  AVNU_PAYMASTER_RPC: z
    .string()
    .url()
    .optional()
    .default('https://sepolia.paymaster.avnu.fi'),
  AVNU_PAYMASTER_API_KEY: z.string().optional(),

  // Deployer account (for transactions)
  DEPLOYER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'Invalid deployer address format'),
  DEPLOYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'Invalid private key format'),
});

/**
 * Alarm contract configuration schema
 */
const alarmConfigSchema = z.object({
  ALARM_CONTRACT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'Invalid alarm contract address'),
  ALARM_VERIFIER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'Invalid alarm verifier private key'),
});

/**
 * Focus lock configuration schema (optional for now)
 */
const focusConfigSchema = z.object({
  FOCUS_CONTRACT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'Invalid focus contract address')
    .optional(),
  FOCUS_VERIFIER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'Invalid focus verifier private key')
    .optional(),
});

/**
 * Complete configuration schema
 */
const configSchema = coreConfigSchema
  .merge(alarmConfigSchema)
  .merge(focusConfigSchema);

/**
 * Parsed and validated configuration
 */
export type Config = z.infer<typeof configSchema>;

let config: Config | null = null;

/**
 * Load and validate configuration from environment
 * @throws {Error} If validation fails
 */
export function loadConfig(): Config {
  if (config) {
    return config;
  }

  try {
    config = configSchema.parse(process.env);
    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(
        (err) => `${err.path.join('.')}: ${err.message}`
      );
      throw new Error(
        `Configuration validation failed:\n${messages.join('\n')}`
      );
    }
    throw error;
  }
}

/**
 * Get alarm-specific configuration
 */
export function getAlarmConfig(): AlarmPoolConfig {
  const cfg = loadConfig();
  return {
    contract_address: cfg.ALARM_CONTRACT_ADDRESS,
    verifier_private_key: cfg.ALARM_VERIFIER_PRIVATE_KEY,
  };
}

/**
 * Get focus lock-specific configuration (if available)
 */
export function getFocusConfig(): FocusLockPoolConfig | null {
  const cfg = loadConfig();
  
  if (!cfg.FOCUS_CONTRACT_ADDRESS || !cfg.FOCUS_VERIFIER_PRIVATE_KEY) {
    return null;
  }

  return {
    contract_address: cfg.FOCUS_CONTRACT_ADDRESS,
    verifier_private_key: cfg.FOCUS_VERIFIER_PRIVATE_KEY,
  };
}

/**
 * Check if AVNU Paymaster is configured
 */
export function hasPaymasterConfig(): boolean {
  const cfg = loadConfig();
  return !!cfg.AVNU_PAYMASTER_API_KEY;
}

/**
 * Get core blockchain configuration
 */
export function getCoreConfig() {
  const cfg = loadConfig();
  return {
    supabaseUrl: cfg.SUPABASE_URL,
    supabaseServiceKey: cfg.SUPABASE_SERVICE_KEY,
    starknetRpcUrl: cfg.STARKNET_RPC_URL,
    starknetChainId: cfg.STARKNET_CHAIN_ID,
    avnuPaymasterRpc: cfg.AVNU_PAYMASTER_RPC,
    avnuPaymasterApiKey: cfg.AVNU_PAYMASTER_API_KEY,
    deployerAddress: cfg.DEPLOYER_ADDRESS,
    deployerPrivateKey: cfg.DEPLOYER_PRIVATE_KEY,
  };
}

