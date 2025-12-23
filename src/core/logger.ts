/**
 * Production-grade structured logging with Pino
 * 
 * Features:
 * - Structured JSON logging in production
 * - Pretty printing in development
 * - Child loggers for module context
 * - 5x faster than Winston
 */

import pino from 'pino';

// Configure base logger based on environment
const isDevelopment = process.env.NODE_ENV === 'development';
const logLevel = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level: logLevel,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      }
    : undefined, // JSON logs in production
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger with module context
 * @param module Module name (e.g., 'alarm-processor', 'blockchain', 'database')
 * @returns Child logger with module context
 */
export function createModuleLogger(module: string) {
  return logger.child({ module });
}

/**
 * Log pool processing start
 */
export function logPoolProcessingStart(day: number, period: 0 | 1) {
  logger.info(
    {
      pool: { day, period },
      event: 'pool_processing_start',
    },
    `Starting pool processing: Day ${day}, Period ${period}`
  );
}

/**
 * Log pool processing success
 */
export function logPoolProcessingSuccess(
  day: number,
  period: 0 | 1,
  txHash: string,
  userCount: number,
  winnerCount: number
) {
  logger.info(
    {
      pool: { day, period },
      txHash,
      userCount,
      winnerCount,
      event: 'pool_processing_success',
    },
    `Pool processed successfully: ${userCount} users, ${winnerCount} winners`
  );
}

/**
 * Log pool processing failure
 */
export function logPoolProcessingFailure(
  day: number,
  period: 0 | 1,
  error: Error
) {
  logger.error(
    {
      pool: { day, period },
      err: error,
      event: 'pool_processing_failure',
    },
    `Pool processing failed: ${error.message}`
  );
}

/**
 * Log blockchain transaction
 */
export function logBlockchainTransaction(
  action: string,
  txHash: string,
  details?: Record<string, unknown>
) {
  logger.info(
    {
      action,
      txHash,
      ...details,
      event: 'blockchain_transaction',
    },
    `Blockchain transaction: ${action}`
  );
}

/**
 * Log database operation
 */
export function logDatabaseOperation(
  operation: string,
  count: number,
  details?: Record<string, unknown>
) {
  logger.info(
    {
      operation,
      count,
      ...details,
      event: 'database_operation',
    },
    `Database operation: ${operation} (${count} records)`
  );
}

export default logger;

