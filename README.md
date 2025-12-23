# Pool Processor

Production-ready TypeScript backend for processing reward pools (alarms & focus locks) with merkle root calculation, SNIP-12 signatures, and blockchain finalization.

## Features

- **Modular Architecture**: Shared core logic with pool-type specific processors
- **Type-Safe**: Full TypeScript with strict mode, no `any` types
- **Production-Ready**: Pino logging, Zod validation, proper error handling
- **Blockchain Integration**: Starknet RPC with AVNU Paymaster support
- **Extensible**: Easy to add new pool types (focus locks) without touching core
- **Cron-Ready**: Proper exit codes, idempotent operations

## Architecture

```
pool-processor/
├── src/
│   ├── core/          # Shared logic (calculator, crypto, blockchain, database)
│   ├── types/         # TypeScript type definitions
│   ├── alarm/         # Alarm pool processors
│   ├── focus/         # Focus lock processors (future)
│   └── index.ts       # CLI entry point
```

## Prerequisites

- Node.js 18+
- pnpm 8+
- Supabase project
- Starknet account with STRK/ETH for gas
- Deployed alarm contract on Starknet

## Setup

### 1. Install Dependencies

```bash
cd pool-processor
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and fill in your values
```

Required environment variables:
- `SUPABASE_URL` & `SUPABASE_SERVICE_KEY`: Database connection
- `STARKNET_RPC_URL`: Starknet node URL (Alchemy, Infura, etc.)
- `DEPLOYER_ADDRESS` & `DEPLOYER_PRIVATE_KEY`: Account for transactions
- `ALARM_CONTRACT_ADDRESS` & `ALARM_VERIFIER_PRIVATE_KEY`: Contract config

### 3. Build (Optional)

```bash
pnpm build
```

## Usage

### Process Alarm Pools

**Process specific pool:**
```bash
pnpm alarm:process 20321 1      # Day 20321, PM period
pnpm alarm:process 20321 0      # Day 20321, AM period
```

**Process current/latest pool:**
```bash
pnpm alarm:process              # Current time pool
pnpm alarm:process auto         # Auto-detect latest
pnpm alarm:process latest       # Same as auto
```

**Force processing (skip time buffer):**
```bash
pnpm alarm:process 20321 1 --force
pnpm alarm:process --force
```

**Process all unprocessed pools:**
```bash
pnpm alarm:process-all          # All pools with claim_ready=false
pnpm alarm:process-all --force  # Skip time buffer for all
```

**Find latest pool:**
```bash
pnpm alarm:find-latest
```

### Exit Codes

- `0`: Success
- `1`: Fatal error
- `2`: Too early (before time buffer)

## Cron Job Setup

### Option 1: Using pnpm (Development)

```bash
# Process all pools every 30 minutes
*/30 * * * * cd /path/to/pool-processor && pnpm alarm:process-all >> logs/alarm-cron.log 2>&1
```

### Option 2: Using node (Production)

```bash
# Build first
cd /path/to/pool-processor
pnpm build

# Add to crontab
*/30 * * * * cd /path/to/pool-processor && node dist/index.js alarm process-all >> logs/alarm-cron.log 2>&1
```

### Cron Setup Tips

1. **Create logs directory:**
   ```bash
   mkdir -p /path/to/pool-processor/logs
   ```

2. **Test manually first:**
   ```bash
   node dist/index.js alarm process-all
   ```

3. **Monitor logs:**
   ```bash
   tail -f logs/alarm-cron.log
   ```

4. **Log rotation (optional):**
   ```bash
   # Install logrotate config
   sudo nano /etc/logrotate.d/pool-processor
   ```

## Development

**Run in dev mode:**
```bash
pnpm dev                        # Watch mode
pnpm alarm:process auto         # Direct execution
```

**Type checking:**
```bash
pnpm type-check
```

**Build:**
```bash
pnpm build
```

## Pool Processing Flow

### Alarm Pools

1. **Fetch alarms** from database (stake_amount > 0, not deleted, in time range)
2. **Validate** user data (types, ranges)
3. **Calculate rewards**:
   - Total slashed from losers (based on snooze count)
   - Protocol fee: 10% of total pool
   - Winners share: 90% distributed proportionally
4. **Build merkle tree**:
   - Aggregate rewards by unique address
   - Generate Poseidon hashes (Starknet compatible)
   - Create proofs for ALL users
5. **Set merkle root on-chain** (CRITICAL - must succeed!)
6. **Store results to database**:
   - Update alarms (claim_ready = true)
   - Insert claim data (signatures, proofs, expiry)

### Time Buffer

Pools are processed 30 minutes after period end to ensure all data is ready.
Use `--force` to skip this check (testing only).

## Stake Return Rules

- **0 snoozes**: 100% stake return + rewards
- **1 snooze**: 80% stake return (20% slashed)
- **2 snoozes**: 50% stake return (50% slashed)
- **3+ snoozes**: 0% stake return (100% slashed)

## Logging

- **Development**: Pretty-printed colored logs
- **Production**: Structured JSON logs
- **Log levels**: trace, debug, info, warn, error, fatal
- **Set level**: `LOG_LEVEL=debug` in `.env`

## Troubleshooting

### "Configuration validation failed"
- Check all required env vars in `.env`
- Ensure addresses start with `0x`
- Verify Supabase URL format

### "Failed to fetch alarms from database"
- Check Supabase connection
- Verify service key has proper permissions
- Check table name and schema match

### "Blockchain transaction failed"
- Ensure deployer account has sufficient STRK/ETH
- Check RPC URL is accessible
- Verify contract address is correct

### "Too early to process pool"
- Pool needs 30-minute buffer after period end
- Use `--force` flag if testing

### "No alarms found for pool"
- Check if any users created alarms for this period
- Verify filters: stake_amount > 0, alarm_id NOT NULL, deleted = false

## Extending for Focus Locks

When implementing focus lock processing:

1. **Add types** in `src/types/focus.ts`
2. **Create processor** in `src/focus/processor.ts` (similar to alarm)
3. **Add SNIP-12 signature** for focus lock struct
4. **Add CLI commands** in `src/index.ts`
5. **Update env vars** for focus contract

Core modules (calculator, crypto, blockchain) are already pool-agnostic.

## Performance

- **Batch operations**: Bulk database updates/inserts
- **Connection pooling**: Supabase client reuse
- **Efficient hashing**: Poseidon via starknet.js
- **Minimal RPC calls**: Single transaction per pool

## Security

- Private keys never logged
- Env validation on startup
- Signature verification before storage
- Contract address validation
- Rate limiting between pools (3s delay)

## License

MIT

## Support

For issues or questions, please open an issue on GitHub.

