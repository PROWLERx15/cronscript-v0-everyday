/**
 * Vercel Cron Handler for Pool Processing
 *
 * Deploy to 2 separate Vercel projects:
 * - Project 1: vercel.json → Runs at 0:30 UTC (processes previous day Period 1)
 * - Project 2: vercel.12-30.json → Runs at 12:30 UTC (processes current day Period 0)
 *
 * Each run processes BOTH alarm and focus lock pools for the scheduled period.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  processCronPools,
  calculatePoolToProcess,
} from '../src/cron/processor.js';
import { loadConfig } from '../src/core/config.js';

/**
 * Verify the request is from Vercel Cron
 */
function verifyRequest(req: VercelRequest): boolean {
  // Vercel sends this header for cron jobs
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  // If no CRON_SECRET is set, allow in development
  if (!cronSecret) {
    console.warn('CRON_SECRET not set - allowing request in development mode');
    return true;
  }

  // Check for Vercel cron header or our custom auth
  if (authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  // Also check x-vercel-cron header (Vercel's internal header)
  const vercelCronHeader = req.headers['x-vercel-cron'];
  if (vercelCronHeader) {
    return true;
  }

  return false;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Only allow GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the request is authorized
  if (!verifyRequest(req)) {
    console.error('Unauthorized cron request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Cron job triggered at:', new Date().toISOString());

  try {
    // Load configuration (validates env vars)
    loadConfig();

    // Get which pool to process based on current UTC time
    const pool = calculatePoolToProcess();
    console.log('Processing pool:', pool);

    // Check for force flag in query params (for manual triggers)
    const force = req.query.force === 'true';
    if (force) {
      console.log('Force flag enabled - skipping time buffer');
    }

    // Process both alarm and focus lock pools
    const result = await processCronPools(force);

    console.log('Cron processing completed:', {
      pool: result.pool,
      alarmSuccess: result.alarm.success,
      focusSuccess: result.focus.success,
      overallSuccess: result.success,
    });

    // Return detailed result
    return res.status(200).json({
      success: result.success,
      pool: result.pool,
      processed_at: result.processed_at,
      alarm: {
        success: result.alarm.success,
        message: result.alarm.message,
        transaction_hash: result.alarm.transaction_hash,
        pool_info: result.alarm.pool_info,
      },
      focus: {
        success: result.focus.success,
        message: result.focus.message,
        transaction_hash: result.focus.transaction_hash,
        pool_info: result.focus.pool_info,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Cron processing failed:', errorMessage);

    return res.status(500).json({
      success: false,
      error: errorMessage,
      processed_at: new Date().toISOString(),
    });
  }
}
