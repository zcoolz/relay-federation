/**
 * block-scanner.js
 *
 * Block scanning logic for whale detection, script taxonomy, and miner identification.
 * Processes parsed transactions in-memory without serializing to JSON.
 */

import { Script } from '@bsv/sdk'

export const WHALE_THRESHOLD_BSV = 100

/**
 * Convert script hex to ASM format.
 * @param {string} scriptHex
 * @returns {string}
 */
export function scriptToAsm(scriptHex) {
  if (!scriptHex) return ''
  try {
    return Script.fromHex(scriptHex).toASM()
  } catch {
    return ''
  }
}

// ============================================================
// Script Analysis Functions
// ============================================================

function detectScriptType(scriptHex, asm) {
  if (!scriptHex || !asm) return 'nonstandard';

  // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  if (asm.startsWith('OP_DUP OP_HASH160') && asm.endsWith('OP_EQUALVERIFY OP_CHECKSIG')) {
    return 'pubkeyhash';
  }

  // P2PK: <pubkey> OP_CHECKSIG
  if (asm.endsWith('OP_CHECKSIG') && !asm.includes('OP_DUP') && !asm.includes('OP_HASH160')) {
    const parts = asm.split(' ');
    if (parts.length === 2 && /^[0-9a-fA-F]+$/.test(parts[0])) {
      return 'pubkey';
    }
  }

  // OP_RETURN (nulldata)
  if (asm.startsWith('OP_RETURN') || asm.startsWith('OP_FALSE OP_RETURN')) {
    return 'nulldata';
  }

  return 'nonstandard';
}

function isInscription(asm) {
  return asm.includes('OP_FALSE OP_IF 6f7264');
}

function isSpendableMetadataScript(asm) {
  const tokens = asm.split(' ').filter(t => t);

  let lastSigCheckPos = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'OP_CHECKSIG' || tokens[i] === 'OP_CHECKSIGVERIFY' ||
        tokens[i] === 'OP_CHECKMULTISIG' || tokens[i] === 'OP_CHECKMULTISIGVERIFY') {
      lastSigCheckPos = i;
    }
  }

  if (lastSigCheckPos === -1) return false;
  if (lastSigCheckPos >= tokens.length - 1) return false;

  const trailingTokens = tokens.slice(lastSigCheckPos + 1);
  const hasDropOp = trailingTokens.some(t => t === 'OP_DROP' || t === 'OP_2DROP');
  if (!hasDropOp) return false;

  const advancedOps = [
    'OP_IF', 'OP_NOTIF', 'OP_ELSE', 'OP_ENDIF', 'OP_VERIFY',
    'OP_HASH256', 'OP_SHA256', 'OP_RIPEMD160', 'OP_HASH160',
    'OP_EQUAL', 'OP_EQUALVERIFY',
    'OP_SPLIT', 'OP_CAT', 'OP_SUBSTR', 'OP_LEFT', 'OP_RIGHT',
    'OP_ADD', 'OP_SUB', 'OP_MUL', 'OP_DIV', 'OP_MOD',
    'OP_LSHIFT', 'OP_RSHIFT', 'OP_AND', 'OP_OR', 'OP_XOR',
    'OP_LESSTHAN', 'OP_GREATERTHAN', 'OP_WITHIN',
    'OP_PICK', 'OP_ROLL', 'OP_TOALTSTACK', 'OP_FROMALTSTACK',
    'OP_SIZE', 'OP_NUM2BIN', 'OP_BIN2NUM',
    'OP_CHECKLOCKTIMEVERIFY', 'OP_CHECKSEQUENCEVERIFY'
  ];

  for (const token of trailingTokens) {
    if (token === 'OP_DROP' || token === 'OP_2DROP') continue;
    if (/^OP_(0|FALSE|TRUE|1NEGATE|1[0-6]?|[2-9])$/.test(token)) continue;
    if (/^[0-9a-fA-F]+$/.test(token)) continue;
    if (advancedOps.includes(token)) return false;
    if (token.startsWith('OP_')) return false;
  }

  return true;
}

function classifyOutput(scriptType, asm) {
  if (scriptType === 'nulldata' || scriptType === 'nonstandard_nulldata') {
    return { purpose: 'DATA_PUBLICATION', structure: 'OP_RETURN' };
  }

  if (isInscription(asm)) {
    return { purpose: 'DATA_PUBLICATION', structure: 'ORDINAL_ENVELOPE' };
  }

  if (isSpendableMetadataScript(asm)) {
    return { purpose: 'DATA_PUBLICATION', structure: 'SPENDABLE_METADATA' };
  }

  if (scriptType === 'pubkeyhash') {
    return { purpose: 'PAYMENT', structure: 'P2PKH' };
  }

  if (scriptType === 'pubkey') {
    return { purpose: 'PAYMENT', structure: 'P2PK' };
  }

  if (asm.includes('OP_CHECKMULTISIG') && !asm.includes('OP_IF') &&
      !asm.includes('OP_SPLIT') && !asm.includes('OP_CAT') &&
      !asm.includes('OP_HASH256') && !asm.includes('OP_TOALTSTACK')) {
    return { purpose: 'PAYMENT', structure: 'MULTISIG' };
  }

  return { purpose: 'CONTRACTS', structure: 'CUSTOM' };
}

function isSimpleDataPush(asm) {
  const parts = asm.split(' ');
  if (parts.length >= 3 && parts[1] === 'OP_CHECKSIG') {
    const rest = parts.slice(2).join(' ');
    const interestingOps = [
      'OP_IF', 'OP_NOTIF', 'OP_ELSE', 'OP_ENDIF',
      'OP_TOALTSTACK', 'OP_FROMALTSTACK',
      'OP_HASH256', 'OP_SHA256', 'OP_RIPEMD160',
      'OP_CHECKMULTISIG', 'OP_CHECKMULTISIGVERIFY',
      'OP_SPLIT', 'OP_CAT', 'OP_PICK', 'OP_ROLL',
      'OP_CHECKLOCKTIMEVERIFY', 'OP_CHECKSEQUENCEVERIFY'
    ];
    return !interestingOps.some(op => rest.includes(op));
  }
  return false;
}

function detectDataProtocols(asm) {
  const protocols = [];
  const tokens = asm.split(' ');

  const protocolMarkers = {
    '31394878696756345179427633744870515663554551797131707a5a56646f417574': 'B://',
    '313550636948473232534e4c514a584d6f5355615756693757537163376843667661': 'AIP',
    '3150755161374b36324d694b43747373534c4b79316b683536575755374d74555235': 'MAP',
    '31436747704e7238514a657a6974536d3566556f50397155734836486d7451564e47': 'BOOST',
    '314469473652746f6e4a53717a4556614d5573686b394b6f636d37366a64554250416d': 'SigmaP',
    '3170726f74564772745a72584a5a776e595a61516f6961534c47584a3174397576': 'BCAT',
  };

  for (const token of tokens) {
    if (protocolMarkers[token]) {
      protocols.push(protocolMarkers[token]);
    }
  }

  if (tokens.includes('7472656563686174')) protocols.push('TreeChat');
  if (tokens.includes('7477657463682e636f6d')) protocols.push('Twetch');
  if (tokens.includes('6f7264') && !asm.includes('OP_IF')) protocols.push('ord-return');
  if (tokens.includes('72756e')) protocols.push('RUN');

  return protocols;
}

function extractOpcodes(asm) {
  const tokens = asm.split(' ').filter(t => t);
  const opcodes = new Set();
  for (const token of tokens) {
    if (token.startsWith('OP_')) opcodes.add(token);
  }
  return Array.from(opcodes);
}

function scoreScript(asm) {
  let score = 0;
  const scoring = {
    'OP_CHECKMULTISIG': 5, 'OP_CHECKMULTISIGVERIFY': 5,
    'OP_TOALTSTACK': 4, 'OP_FROMALTSTACK': 4,
    'OP_HASH256': 3, 'OP_SHA256': 3, 'OP_RIPEMD160': 3,
    'OP_IF': 3, 'OP_NOTIF': 3, 'OP_ELSE': 2, 'OP_ENDIF': 1,
    'OP_SPLIT': 3, 'OP_CAT': 3,
    'OP_PICK': 2, 'OP_ROLL': 2,
    'OP_CHECKLOCKTIMEVERIFY': 4, 'OP_CHECKSEQUENCEVERIFY': 4,
    'OP_CODESEPARATOR': 3,
    'OP_SWAP': 1, 'OP_ROT': 1, 'OP_OVER': 1,
    'OP_SIZE': 2, 'OP_NUM2BIN': 2, 'OP_BIN2NUM': 2,
    'OP_MUL': 2, 'OP_DIV': 2, 'OP_MOD': 2,
    'OP_LSHIFT': 2, 'OP_RSHIFT': 2,
    'OP_AND': 2, 'OP_OR': 2, 'OP_XOR': 2,
    'OP_WITHIN': 2, 'OP_LESSTHAN': 1, 'OP_GREATERTHAN': 1,
  };

  const uniqueOps = new Set();
  for (const [op, points] of Object.entries(scoring)) {
    const regex = new RegExp(op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const count = (asm.match(regex) || []).length;
    if (count > 0) {
      score += points * Math.min(count, 5);
      uniqueOps.add(op);
    }
  }

  if (uniqueOps.size >= 3) score += uniqueOps.size * 2;
  if (uniqueOps.size >= 6) score += uniqueOps.size * 3;

  return { score, uniqueOps: Array.from(uniqueOps) };
}

function extractMiner(coinbaseHex) {
  if (!coinbaseHex) return 'unknown';
  try {
    const ascii = Buffer.from(coinbaseHex, 'hex').toString('ascii');
    const poolPatterns = [
      { pattern: /taal\.com.*Teranode/i, name: 'taal.com_Teranode' },
      { pattern: /taal\.com/i, name: 'taal.com' },
      { pattern: /TAAL/i, name: 'TAAL' },
      { pattern: /GorillaPool/i, name: 'GorillaPool' },
      { pattern: /gorilla/i, name: 'GorillaPool' },
      { pattern: /Mining-Dutch/i, name: 'Mining-Dutch' },
      { pattern: /molepool\.com/i, name: 'molepool.com' },
      { pattern: /qdlnk/i, name: 'qdlnk' },
      { pattern: /CUVVE/i, name: 'CUVVE' },
      { pattern: /SA100/i, name: 'SA100' },
      { pattern: /ViaBTC/i, name: 'ViaBTC' },
      { pattern: /AntPool/i, name: 'AntPool' },
      { pattern: /F2Pool/i, name: 'F2Pool' },
      { pattern: /SBI Crypto/i, name: 'SBI Crypto' },
      { pattern: /Mempool/i, name: 'Mempool.com' },
    ];
    for (const { pattern, name } of poolPatterns) {
      if (pattern.test(ascii)) return name;
    }
    const readable = ascii.match(/[\x20-\x7E]{4,}/g);
    if (readable && readable.length > 0) {
      const longest = readable.sort((a, b) => b.length - a.length)[0].trim();
      if (longest.length >= 4) return longest;
    }
  } catch (e) {}
  return 'unknown';
}

// ============================================================
// Main Block Scanning Function
// ============================================================

/**
 * Scan a block's transactions and return aggregated results.
 * @param {Array} transactions - Array of parsed transactions from P2P
 * @param {number} blockHeight - Block height
 * @returns {object} Scan results for this block
 */
export function scanBlock(transactions, blockHeight) {
  const whales = [];
  const interestingScripts = [];
  let miner = 'unknown';
  let txCount = 0;
  let totalValue = 0;
  let inscriptionsSkipped = 0;
  let dataPushesSkipped = 0;

  const purposeCounts = { PAYMENT: 0, DATA_PUBLICATION: 0, CONTRACTS: 0 };
  const structureCounts = {
    P2PKH: 0, P2PK: 0, MULTISIG: 0,
    OP_RETURN: 0, ORDINAL_ENVELOPE: 0, SPENDABLE_METADATA: 0,
    CUSTOM: 0
  };
  const protocolCounts = {};
  const templateCounts = {};

  for (const tx of transactions) {
    txCount++;
    const inputs = tx.inputs || [];
    const outputs = tx.outputs || [];

    // --- COINBASE TX: extract miner identity ---
    const isCoinbase = inputs.length === 1 &&
      inputs[0].prevTxid === '0000000000000000000000000000000000000000000000000000000000000000';

    if (isCoinbase && inputs[0].coinbase) {
      miner = extractMiner(inputs[0].coinbase);
    }

    // --- Calculate total output value ---
    let txTotalValue = 0;
    for (const out of outputs) {
      txTotalValue += (out.satoshis || 0) / 1e8;
    }
    totalValue += txTotalValue;

    // Skip further processing for coinbase
    if (isCoinbase) continue;

    // --- WHALE CHECK ---
    if (txTotalValue >= WHALE_THRESHOLD_BSV) {
      let pattern = 'neutral';
      if (inputs.length >= 5 && outputs.length <= 2) pattern = 'consolidation';
      else if (inputs.length <= 2 && outputs.length >= 5) pattern = 'distribution';
      else if (inputs.length >= 3 && outputs.length >= 3) pattern = 'complex';

      whales.push({
        txid: tx.txid,
        blockHeight,
        valueBSV: Math.round(txTotalValue * 1e8) / 1e8,
        outputCount: outputs.length,
        inputCount: inputs.length,
        pattern
      });
    }

    // --- SCRIPT ANALYSIS ---
    for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
      const out = outputs[outIdx];
      const scriptHex = out.scriptHex || '';
      const asm = scriptToAsm(scriptHex);
      const sizeBytes = scriptHex.length / 2;
      const scriptType = detectScriptType(scriptHex, asm);

      // === TAXONOMY TRACKING ===
      const { purpose, structure } = classifyOutput(scriptType, asm);
      purposeCounts[purpose]++;
      structureCounts[structure]++;

      // Protocol detection for data publication
      if (purpose === 'DATA_PUBLICATION') {
        const protocols = detectDataProtocols(asm);
        for (const proto of protocols) {
          protocolCounts[proto] = (protocolCounts[proto] || 0) + 1;
        }
      }

      // Track ordinals and simple data pushes
      if (structure === 'ORDINAL_ENVELOPE') {
        inscriptionsSkipped++;
        continue;
      }
      if (isSimpleDataPush(asm)) {
        dataPushesSkipped++;
        continue;
      }

      // Only track interesting CONTRACT scripts
      if (purpose !== 'CONTRACTS') continue;

      const { score, uniqueOps } = scoreScript(asm);

      // Build tags
      const tags = [];
      if (asm.includes('OP_CHECKMULTISIG')) tags.push('MULTISIG');
      if (asm.includes('OP_SHA256') || asm.includes('OP_HASH256') || asm.includes('OP_RIPEMD160')) tags.push('HASH_PUZZLE');
      if (asm.includes('OP_TOALTSTACK') || asm.includes('OP_FROMALTSTACK')) tags.push('ALT_STACK');
      if (asm.includes('OP_IF') || asm.includes('OP_NOTIF')) tags.push('CONDITIONAL');
      if (asm.includes('OP_SPLIT') || asm.includes('OP_CAT')) tags.push('BYTE_OPS');
      if (asm.includes('OP_CHECKLOCKTIMEVERIFY') || asm.includes('OP_CHECKSEQUENCEVERIFY')) tags.push('TIMELOCK');
      if (tags.length === 0) tags.push('NONSTANDARD');

      // Track template for deduplication
      const templateOps = uniqueOps.sort().join(',');
      templateCounts[templateOps] = (templateCounts[templateOps] || 0) + 1;

      interestingScripts.push({
        txid: tx.txid,
        blockHeight,
        outputIndex: outIdx,
        valueBSV: (out.satoshis || 0) / 1e8,
        sizeBytes,
        complexityScore: score,
        uniqueOps,
        tags,
        asmPreview: asm.substring(0, 200)
      });
    }
  }

  return {
    blockHeight,
    txCount,
    miner,
    totalValueBSV: Math.round(totalValue * 1e8) / 1e8,
    whales,
    interestingScripts: interestingScripts.slice(0, 100), // Limit to top 100
    taxonomy: {
      purposeCounts,
      structureCounts,
      protocolCounts,
      uniqueTemplates: Object.keys(templateCounts).length
    },
    stats: {
      inscriptionsSkipped,
      dataPushesSkipped
    }
  };
}

// Helper functions are used internally by scanBlock
// Primary exports: scanBlock, scriptToAsm, WHALE_THRESHOLD_BSV
