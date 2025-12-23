#!/usr/bin/env node

/**
 * CLI Entry Point for Pool Processor
 * 
 * Provides command-line interface for processing alarm and focus lock pools
 */

import { Command } from 'commander';
import { processAlarmPool } from './alarm/processor.js';
import { processAllAlarmPools } from './alarm/batch-processor.js';
import {
  findLatestAlarmPool,
  getCurrentPoolInfo,
  displayPoolInfo,
} from './alarm/finder.js';
import { loadConfig } from './core/config.js';
import { logger } from './core/logger.js';

const program = new Command();

program
  .name('pool-processor')
  .description('Production TypeScript backend for processing reward pools')
  .version('1.0.0');

// Alarm commands
const alarmCommand = program
  .command('alarm')
  .description('Alarm pool processing commands');

// Process single alarm pool
alarmCommand
  .command('process [day] [period]')
  .description('Process specific alarm pool (or current/auto/latest)')
  .option('-f, --force', 'Skip time buffer check')
  .action(async (day, period, options) => {
    try {
      // Load config to validate env vars
      loadConfig();

      let poolDay: number;
      let poolPeriod: 0 | 1;

      if (!day || day === 'current' || day === 'auto' || day === 'latest') {
        // Auto-detect latest pool
        logger.info('Auto-detecting latest alarm pool');
        const latestPool = await findLatestAlarmPool();

        if (!latestPool) {
          logger.warn('No alarm pools found, using current time');
          const currentPool = getCurrentPoolInfo();
          poolDay = currentPool.day;
          poolPeriod = currentPool.period;
        } else {
          poolDay = latestPool.day;
          poolPeriod = latestPool.period;
        }
      } else {
        poolDay = parseInt(day);
        poolPeriod = parseInt(period) as 0 | 1;

        if (isNaN(poolDay) || isNaN(poolPeriod) || poolPeriod < 0 || poolPeriod > 1) {
          logger.error('Invalid day/period. Period must be 0 (AM) or 1 (PM)');
          process.exit(1);
        }
      }

      logger.info({ day: poolDay, period: poolPeriod }, 'Processing alarm pool');

      const result = await processAlarmPool(poolDay, poolPeriod, options.force);

      if (result.success) {
        logger.info({ result: result.pool_info }, 'Pool processed successfully');
        process.exit(0);
      } else {
        logger.warn({ message: result.message }, 'Pool processing completed with issues');
        process.exit(result.message?.includes('Too early') ? 2 : 1);
      }
    } catch (error) {
      logger.error({ error }, 'Pool processing failed');
      process.exit(1);
    }
  });

// Process all unprocessed alarm pools
alarmCommand
  .command('process-all')
  .description('Process all unprocessed alarm pools')
  .option('-f, --force', 'Skip time buffer check for all pools')
  .action(async (options) => {
    try {
      loadConfig();

      logger.info('Processing all unprocessed alarm pools');
      const result = await processAllAlarmPools(options.force);

      logger.info(
        {
          total: result.total,
          success: result.success,
          failed: result.failed,
        },
        'Batch processing completed'
      );

      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error({ error }, 'Batch processing failed');
      process.exit(1);
    }
  });

// Find latest alarm pool
alarmCommand
  .command('find-latest')
  .description('Find latest alarm pool with alarms')
  .action(async () => {
    try {
      loadConfig();

      const latestPool = await findLatestAlarmPool();

      if (!latestPool) {
        logger.warn('No alarm pools found');
        process.exit(1);
      }

      console.log('\nLatest Alarm Pool:');
      console.log(displayPoolInfo(latestPool));
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Failed to find latest pool');
      process.exit(1);
    }
  });

// Focus commands (future)
program
  .command('focus')
  .description('Focus lock pool processing commands (coming soon)')
  .action(() => {
    logger.info('Focus lock processing not yet implemented');
    process.exit(0);
  });

program.parse();

