# Pool Processor Security Analysis

> **Document Type**: Security Vulnerability Assessment
> **Version**: 1.0
> **Last Updated**: December 2024
> **Scope**: Backend pool processor for Everyday alarm/focus lock rewards

---

## Executive Summary

This document outlines security vulnerabilities, risks, and recommendations for the `pool-processor` TypeScript backend. The system handles cryptographic signing, blockchain transactions, and database operations for distributing rewards on Starknet.

**Risk Level**: **HIGH** - Private keys in environment variables, centralized signing authority

---

## Table of Contents

1. [Critical Vulnerabilities](#1-critical-vulnerabilities)
2. [High-Risk Issues](#2-high-risk-issues)
3. [Medium-Risk Issues](#3-medium-risk-issues)
4. [Low-Risk Issues](#4-low-risk-issues)
5. [Recommendations](#5-recommendations)
6. [Environment Variables Security](#6-environment-variables-security)

---

## 1. Critical Vulnerabilities

### 1.1 Private Keys in Environment Variables

**Location**: `env.example`, `src/core/config.ts`

**Issue**: Multiple private keys are stored as plain text environment variables:

```env
DEPLOYER_PRIVATE_KEY=0x...
ALARM_VERIFIER_PRIVATE_KEY=0x...
FOCUS_VERIFIER_PRIVATE_KEY=0x...
```

**Attack Vectors**:
- **Process memory dump**: Private keys exist in plain memory during runtime
- **Environment leakage**: Keys may appear in process listings, logs, or crash dumps
- **Container/host compromise**: Any server access exposes all keys
- **CI/CD pipeline exposure**: Keys may leak through build logs or artifacts
- **Accidental git commit**: `.env` file mistakenly committed to repository

**Impact**:
- Complete compromise of deployer account (funds + contract control)
- Ability to forge signatures for any user claim
- Potential draining of all staked funds via malicious merkle roots

**Severity**: CRITICAL

---

### 1.2 Centralized Signature Authority (Single Point of Failure)

**Location**: `src/core/crypto.ts`

**Issue**: A single private key (`ALARM_VERIFIER_PRIVATE_KEY`) signs all claim outcomes:

```typescript
const signature = ec.starkCurve.sign(messageHashHex, normalizedPrivateKey);
```

**Attack Vectors**:
- Key compromise allows forging signatures for arbitrary claims
- Insider threat: Anyone with key access can sign fraudulent claims
- No multi-sig or threshold signing for high-value operations

**Impact**:
- Attacker can claim rewards for any user
- No audit trail distinguishing legitimate vs forged signatures

**Severity**: CRITICAL

---

### 1.3 Supabase Service Role Key Exposure

**Location**: `src/core/database.ts`, `env.example`

**Issue**: The `SUPABASE_SERVICE_KEY` is a service role key with full database access:

```typescript
supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
```

**Attack Vectors**:
- Service key bypasses all Row Level Security (RLS) policies
- Attacker can read/modify any data in entire database
- No user-scoped authentication for backend operations

**Impact**:
- Complete database compromise
- Modification of alarm records, claim data, user profiles
- Privacy breach of all user data

**Severity**: CRITICAL

---

## 2. High-Risk Issues

### 2.1 No Rate Limiting on Blockchain Transactions

**Location**: `src/core/blockchain.ts`

**Issue**: No rate limiting or transaction batching controls:

```typescript
const result = await this.account!.execute([call], undefined, {
  resourceBounds: { ... },
  nonce,
});
```

**Attack Vectors**:
- Compromised processor could spam blockchain with transactions
- Replay attacks if nonce handling fails
- Resource exhaustion via repeated transaction attempts

**Impact**:
- Gas/fee draining from deployer account
- Potential denial of service
- Network spam affecting other users

**Severity**: HIGH

---

### 2.2 Logging Sensitive Data

**Location**: `src/core/crypto.ts`, `src/core/logger.ts`

**Issue**: Debug logs may contain sensitive cryptographic material:

```typescript
log.debug(
  {
    messageHash: messageHashHex,
    signatureR: toHexString(signature.r),
  },
  'SNIP-12 signature created'
);
```

**Attack Vectors**:
- Log aggregation systems may store signatures
- Debug mode in production could leak message hashes
- Log files accessible to unauthorized parties

**Impact**:
- Signature components exposed (though not full key)
- Potential correlation attacks with on-chain data

**Severity**: HIGH

---

### 2.3 No Integrity Verification of Merkle Tree Construction

**Location**: `src/core/calculator.ts`

**Issue**: Merkle tree is built in memory without cryptographic integrity checks:

```typescript
const merkleTree = buildMerkleTree(leaves);
```

**Attack Vectors**:
- Memory corruption could alter merkle tree
- No external verification before blockchain submission
- Single-pass construction with no redundancy

**Impact**:
- Incorrect rewards distribution
- Users unable to claim valid rewards

**Severity**: HIGH

---

### 2.4 Force Flag Bypasses Time Buffer

**Location**: `src/alarm/processor.ts`

**Issue**: The `-f/--force` flag skips critical timing checks:

```typescript
if (!force) {
  // Time buffer check
  if (now < readyTime) { ... }
} else {
  log.warn({ pool: { day, period } }, 'Forcing pool processing (buffer check skipped)');
}
```

**Attack Vectors**:
- Operator error could process pool prematurely
- Race condition exploitation before all alarms are final
- Potential for incomplete data processing

**Impact**:
- Users who should have woken up get slashed
- Inconsistent pool state on-chain vs off-chain

**Severity**: HIGH

---

## 3. Medium-Risk Issues

### 3.1 Type Assertions Without Validation

**Location**: `src/core/database.ts`

**Issue**: Unsafe type casting from database results:

```typescript
const record = alarm as unknown as DatabaseAlarmRecord;
```

**Attack Vectors**:
- Malformed database data could cause runtime errors
- Type mismatches may lead to incorrect calculations

**Impact**:
- Processing failures
- Potential reward miscalculation

**Severity**: MEDIUM

---

### 3.2 Singleton Pattern Memory Leaks

**Location**: `src/core/blockchain.ts`, `src/core/database.ts`

**Issue**: Global singleton instances persist for entire runtime:

```typescript
let blockchainService: BlockchainService | null = null;
let supabaseClient: SupabaseClient | null = null;
```

**Attack Vectors**:
- Memory exhaustion in long-running processes
- Stale connections not refreshed
- No connection pool management

**Impact**:
- Service degradation over time
- Resource exhaustion

**Severity**: MEDIUM

---

### 3.3 No Transaction Simulation Before Execution

**Location**: `src/core/blockchain.ts`

**Issue**: Transactions are executed without prior simulation:

```typescript
const result = await this.account!.execute([call], undefined, { ... });
```

**Attack Vectors**:
- Failed transactions still consume gas
- No pre-flight validation of contract state
- Unexpected reverts waste resources

**Impact**:
- Wasted transaction fees
- Delayed processing due to failures

**Severity**: MEDIUM

---

### 3.4 Expiry Window is Fixed (48 Hours)

**Location**: `src/core/crypto.ts`

**Issue**: Claim expiry is hardcoded with no flexibility:

```typescript
const EXPIRY_DURATION = 48 * 60 * 60; // 48 hours
```

**Attack Vectors**:
- Users may miss claim window
- No emergency extension mechanism
- Inflexible for network congestion scenarios

**Impact**:
- Users lose valid claims
- Poor UX during network issues

**Severity**: MEDIUM

---

### 3.5 No Idempotency Protection

**Location**: `src/alarm/processor.ts`

**Issue**: No protection against double-processing a pool:

```typescript
export async function processAlarmPool(
  day: number,
  period: 0 | 1,
  force = false
): Promise<ProcessingResult>
```

**Attack Vectors**:
- Accidental re-run could overwrite data
- Database race conditions
- Duplicate blockchain transactions

**Impact**:
- Data inconsistency
- Wasted gas on redundant transactions

**Severity**: MEDIUM

---

## 4. Low-Risk Issues

### 4.1 No Input Sanitization for CLI Arguments

**Location**: `src/index.ts`

**Issue**: CLI arguments parsed without strict validation:

```typescript
poolDay = parseInt(day);
poolPeriod = parseInt(period) as 0 | 1;
```

**Attack Vectors**:
- Malformed input could cause unexpected behavior
- Edge cases not fully handled

**Impact**: Minimal - CLI is internal tool

**Severity**: LOW

---

### 4.2 Hardcoded Gas Limits

**Location**: `src/core/blockchain.ts`

**Issue**: Static gas configuration:

```typescript
resourceBounds: {
  l1_gas: { max_amount: '0x186a0', max_price_per_unit: '0x5f5e100' },
  l2_gas: { max_amount: '0x0', max_price_per_unit: '0x0' }
}
```

**Attack Vectors**:
- Transactions may fail under high network load
- Overpaying during low-congestion periods

**Impact**: Occasional transaction failures

**Severity**: LOW

---

### 4.3 No Health Check Endpoint

**Issue**: No way to verify processor health externally

**Impact**:
- Difficult to monitor service status
- Silent failures go undetected

**Severity**: LOW

---

## 5. Recommendations

### 5.1 Immediate Actions (Critical)

1. **Use Hardware Security Module (HSM) or Cloud KMS**
   - Migrate private keys to AWS KMS, Google Cloud HSM, or HashiCorp Vault
   - Keys never leave the secure enclave
   - All signing operations happen within HSM

2. **Implement Multi-Signature for Critical Operations**
   - Require 2-of-3 signatures for merkle root submission
   - Use Starknet account abstraction for multi-sig

3. **Replace Service Role Key**
   - Create scoped API keys with minimal permissions
   - Implement Row Level Security (RLS) policies
   - Use JWT-based authentication for backend

### 5.2 Short-Term Improvements (High Priority)

4. **Add Transaction Simulation**
   ```typescript
   const simResult = await provider.simulateTransaction(calls);
   if (!simResult.success) throw new Error('Simulation failed');
   ```

5. **Implement Idempotency**
   - Add unique processing ID per pool
   - Check on-chain merkle root before processing
   - Use database locks for concurrent processing

6. **Secure Logging**
   - Remove all cryptographic data from logs
   - Use structured logging with data classification
   - Implement log encryption at rest

7. **Add Rate Limiting**
   - Maximum transactions per minute
   - Cooldown periods between pool processing
   - Circuit breaker for failed transactions

### 5.3 Medium-Term Improvements

8. **Add Pre-Processing Verification**
   - Verify pool state on-chain before processing
   - Cross-reference database with blockchain data
   - Implement merkle tree verification after construction

9. **Improve Error Handling**
   - Categorize errors (retryable vs fatal)
   - Implement exponential backoff
   - Add circuit breaker patterns

10. **Add Monitoring & Alerting**
    - Health check endpoints
    - Prometheus metrics
    - PagerDuty/Slack alerts for failures

---

## 6. Environment Variables Security

### Current State

| Variable | Sensitivity | Current Storage | Recommended |
|----------|-------------|-----------------|-------------|
| `DEPLOYER_PRIVATE_KEY` | CRITICAL | Plain text env | HSM/KMS |
| `ALARM_VERIFIER_PRIVATE_KEY` | CRITICAL | Plain text env | HSM/KMS |
| `FOCUS_VERIFIER_PRIVATE_KEY` | CRITICAL | Plain text env | HSM/KMS |
| `SUPABASE_SERVICE_KEY` | HIGH | Plain text env | Vault + rotation |
| `AVNU_PAYMASTER_API_KEY` | MEDIUM | Plain text env | Secret manager |
| `STARKNET_RPC_URL` | LOW | Plain text env | OK |

### Recommended Key Management Architecture

```
+----------------+     +------------------+     +-------------------+
|                |     |                  |     |                   |
|  Pool Processor+---->+  Cloud KMS/HSM   +---->+  Starknet Network |
|                |     |                  |     |                   |
+-------+--------+     +------------------+     +-------------------+
        |
        |  (Scoped JWT)
        v
+-------+--------+
|                |
|  Supabase      |
|  (RLS enabled) |
|                |
+----------------+
```

### Secret Rotation Schedule

| Secret Type | Recommended Rotation | Priority |
|-------------|---------------------|----------|
| Deployer Private Key | Never (use new account) | N/A |
| Verifier Keys | Monthly | HIGH |
| Supabase Service Key | Weekly | HIGH |
| RPC API Keys | Monthly | MEDIUM |
| Paymaster API Key | Monthly | MEDIUM |

---

## Appendix: Attack Surface Summary

```
                           ATTACK SURFACE MAP
+--------------------------------------------------------------------------+
|                                                                          |
|   [Environment Variables]                                                |
|   Risk: CRITICAL                                                         |
|   - Private keys exposed in memory                                       |
|   - No encryption at rest                                                |
|                                                                          |
|   [Database Layer]                                                       |
|   Risk: HIGH                                                             |
|   - Service key bypasses RLS                                             |
|   - No query auditing                                                    |
|                                                                          |
|   [Blockchain Layer]                                                     |
|   Risk: HIGH                                                             |
|   - Single deployer account                                              |
|   - No multi-sig protection                                              |
|   - Centralized signing authority                                        |
|                                                                          |
|   [Application Layer]                                                    |
|   Risk: MEDIUM                                                           |
|   - Force flag abuse                                                     |
|   - No idempotency                                                       |
|   - Logging sensitive data                                               |
|                                                                          |
+--------------------------------------------------------------------------+
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Dec 2024 | Security Review | Initial assessment |

---

> **Note**: This document should be treated as **CONFIDENTIAL** and not shared publicly as it details exploitable vulnerabilities.
