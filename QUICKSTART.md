# Quick Start Guide

## Installation & First Run

### 1. Install Dependencies

```bash
cd pool-processor
pnpm install
```

### 2. Setup Environment

```bash
# Copy env.example to .env
cp env.example .env

# Edit .env with your values
nano .env  # or use your preferred editor
```

**Minimum required values:**
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Service role key (not anon key!)
- `STARKNET_RPC_URL` - Starknet node URL (get from Alchemy/Infura)
- `DEPLOYER_ADDRESS` - Your Starknet account address
- `DEPLOYER_PRIVATE_KEY` - Your private key (starts with 0x)
- `ALARM_CONTRACT_ADDRESS` - Deployed alarm contract address
- `ALARM_VERIFIER_PRIVATE_KEY` - Verifier private key for signatures

### 3. Test Configuration

```bash
# This will validate your .env file
pnpm alarm:find-latest
```

If you see "Configuration validation failed", check your `.env` file.

### 4. Process Your First Pool

**Test with latest pool:**
```bash
pnpm alarm:process latest
```

**Or process a specific pool:**
```bash
# Calculate day/period from a timestamp:
# day = floor(timestamp / 86400)
# period = floor((timestamp % 86400) / 43200)  // 0=AM, 1=PM

pnpm alarm:process 20321 1  # Day 20321, PM period
```

**Process all unprocessed pools:**
```bash
pnpm alarm:process-all
```

## Common Commands

```bash
# Development
pnpm alarm:process auto              # Process latest pool
pnpm alarm:process-all               # Process all unprocessed
pnpm alarm:find-latest               # Find latest pool info

# With force flag (skip time buffer)
pnpm alarm:process --force
pnpm alarm:process-all --force

# Build for production
pnpm build

# Run built version
node dist/index.js alarm process-all
```

## Understanding Pool Info

Pools are 12-hour periods:
- **Day**: `floor(timestamp / 86400)` - Unix day number
- **Period**: 
  - `0` = AM (00:00-11:59 UTC)
  - `1` = PM (12:00-23:59 UTC)

Example:
- Timestamp: `1735041600` (Dec 24, 2024, 2:00 PM UTC)
- Day: `20093`
- Period: `1` (PM)

## Verification

After processing, check:

1. **Supabase database:**
   - `alarms` table: `claim_ready = true`
   - `user_claim_data` table: New rows with signatures

2. **Blockchain:**
   - Contract explorer: Check transaction hash
   - Call `get_pool_info(day, period)` to verify merkle root

3. **Logs:**
   - Development: Pretty colored logs
   - Production: JSON logs in `logs/` directory

## Troubleshooting

**"Too early to process pool"**
- Pools need 30-minute buffer after period end
- Use `--force` flag if testing

**"No alarms found for pool"**
- Check if users created alarms for this period
- Verify database filters in Supabase

**"Configuration validation failed"**
- Check all env vars are set
- Addresses must start with `0x`
- Use service key (not anon key) for Supabase

**"Transaction failed"**
- Check deployer has STRK/ETH for gas
- Verify RPC URL is accessible
- Check contract address is correct

## Next Steps

1. **Setup Cron Job** (See README.md)
2. **Monitor Logs** (`tail -f logs/alarm-cron.log`)
3. **Add Focus Locks** (When ready - see README.md)

## Architecture

```
Request Flow:
1. Fetch alarms from database ✓
2. Calculate rewards (90% to winners, 10% protocol fee) ✓
3. Build merkle tree with Poseidon hashing ✓
4. Set merkle root on-chain (Starknet transaction) ✓
5. Store signatures & proofs in database ✓
6. Users can now claim from frontend! ✓
```

## Support

- Issues: Open GitHub issue
- Docs: See README.md for full documentation
- Logs: Check logs/ directory for detailed output

