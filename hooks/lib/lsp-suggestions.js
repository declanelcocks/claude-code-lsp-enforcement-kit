'use strict';

/**
 * lsp-suggestions.js — shared helper for LSP enforcement hooks
 *
 * Builds symbol-navigation suggestions for blocked Bash/Grep/Glob calls,
 * and warmup instructions for the Read gate — all pointed at Claude
 * Code's native `LSP` tool (operation-based: goToDefinition,
 * findReferences, hover, documentSymbol, workspaceSymbol,
 * goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls).
 *
 * No MCP server (cclsp, Serena, or any other mcp__*-namespaced LSP
 * implementation) is ever suggested, detected, or treated as a
 * substitute. This harness exposes LSP natively; there is no "provider"
 * to pick between, and none should be reintroduced here.
 */

const fs = require('fs');
const path = require('path');

// ── Anchor-file resolution ──────────────────────────────────────────────
// Every native LSP operation requires filePath/line/character, including
// workspaceSymbol — a workspace-wide search that still needs *some* real
// file to anchor the request. Left to the agent, this turns into a
// multi-turn Bash `find` hunt for any valid file before the actually
// useful call can even be attempted (observed directly: `filePath: "."`
// rejected, then a `.mod` file rejected as "no LSP server for this file
// type", before a real .go file was found three tool calls later).
// Resolving one here — a single cheap, bounded, synchronous directory
// scan — turns that into zero extra turns.
const ANCHOR_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cpp|cc|c|h|hpp)$/i;
const ANCHOR_SKIP_DIRS = /^(\.git|node_modules|vendor|dist|build|out|\.next|\.turbo|coverage)$/;
const ANCHOR_MAX_DIRS = 400;

/**
 * Find a real, language-appropriate source file to use as the required
 * `filePath` anchor for an LSP call that doesn't otherwise need one
 * (chiefly `workspaceSymbol`). `hint` is whatever path context the
 * calling hook already has on hand (a Grep/Glob `path` param, a file
 * being Read, etc.) — used as the starting point of the scan; falls back
 * to the current working directory when absent or invalid. Bounded
 * breadth-first scan, skips common non-source directories. Returns null
 * (never throws) if nothing turns up within the bound.
 */
function resolveAnchorFile(hint) {
  let root;
  try {
    if (hint && fs.existsSync(hint)) {
      root = fs.statSync(hint).isDirectory() ? hint : path.dirname(hint);
    } else {
      root = process.cwd();
    }
  } catch {
    root = process.cwd();
  }

  const queue = [root];
  let dirsScanned = 0;
  while (queue.length && dirsScanned < ANCHOR_MAX_DIRS) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirsScanned++;

    const subdirs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (!ANCHOR_SKIP_DIRS.test(entry.name)) subdirs.push(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && ANCHOR_EXTENSIONS.test(entry.name)) {
        return path.join(dir, entry.name);
      }
    }
    queue.push(...subdirs);
  }
  return null;
}

// ── Native LSP operation map ────────────────────────────────────────────
// abstract intent → operation name(s) for Claude Code's built-in `LSP`
// tool (operation enum: goToDefinition, findReferences, hover,
// documentSymbol, workspaceSymbol, goToImplementation,
// prepareCallHierarchy, incomingCalls, outgoingCalls).
const NATIVE_OPERATIONS = {
  definition:      ['goToDefinition', 'documentSymbol'],
  references:      ['findReferences'],
  symbol_search:   ['workspaceSymbol'],
  implementation:  ['goToImplementation'],
  callsite:        ['incomingCalls'],
  hover:           ['hover'],
  outgoing_calls:  ['outgoingCalls'],
  // Any of these satisfies a bare (shape-ambiguous) identifier.
  bare:            ['goToDefinition', 'findReferences', 'goToImplementation', 'workspaceSymbol'],
};

// grep/glob/sed/awk-pattern shape → the native operation(s) required to
// satisfy it. Reuses the same operation lists as the suggestion intents
// above — one symbol classification, one source of truth for both the
// suggestion text and the enforcement check.
const REQUIRED_OPS_BY_SHAPE = {
  declaration: NATIVE_OPERATIONS.definition,
  callsite:    NATIVE_OPERATIONS.callsite,
  bare:        NATIVE_OPERATIONS.bare,
};

/**
 * Classify how `symbol` occurs in `rawText` (declaration-shaped,
 * call-site-shaped, or bare), given that `symbol` is already known to be
 * a plausible identifier. Used once a symbol has already been extracted
 * by a hook's own token-based logic.
 */
function classifySymbolShape(rawText, symbol) {
  const esc = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
  if (new RegExp(`\\b(?:func|type|const|var|class|interface|struct)\\s+${esc}\\b`).test(rawText)) {
    return 'declaration';
  }
  if (new RegExp(`${esc}\\s*\\(`).test(rawText)) {
    return 'callsite';
  }
  return 'bare';
}

/**
 * Scan raw text (a shell command, a Grep/Glob pattern, a sed/awk address
 * expression — anything a hook has on hand) directly for a declaration-
 * or call-site-shaped symbol occurrence, independent of a hook's own
 * whitespace-sensitive token extraction. Multi-word forms like
 * `"func handleSubmit"` or `"type UserService struct"` contain a space
 * and would never survive a single-token bare-identifier extractor, so
 * this checks the whole string instead.
 *
 * `looksLikeSymbol` is the caller's own "is this a plausible identifier,
 * not a keyword/short word" predicate (each hook already has one) —
 * required so a bare `if (`/`for (`/`switch (` doesn't get misread as a
 * call-site.
 *
 * Returns { identifier, shape } or null.
 */
function findDeclarationOrCallsite(rawText, looksLikeSymbol) {
  const declMatch = rawText.match(/\b(?:func|type|const|var|class|interface|struct)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (declMatch && looksLikeSymbol(declMatch[1])) {
    return { identifier: declMatch[1], shape: 'declaration' };
  }
  const callMatch = rawText.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (callMatch && looksLikeSymbol(callMatch[1])) {
    return { identifier: callMatch[1], shape: 'callsite' };
  }
  return null;
}

/**
 * True if a prior `LSP` tool call this session (per the transcript)
 * already satisfies `identifier` for one of `requiredOps`. A request
 * alone rarely carries the identifier (goToDefinition/findReferences/...
 * take a filePath+line+character, not a name), so this pairs each LSP
 * tool_use's id to its operation, then checks the paired tool_result's
 * content — plus the request itself, which covers workspaceSymbol's
 * `query` field.
 */
function isLspSatisfied(transcriptPath, identifier, requiredOps) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;

  const idToOperation = new Map();
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return false;
  }

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use' && block.name === 'LSP') {
        const input = block.input || {};
        const op = input.operation;
        if (block.id) idToOperation.set(block.id, op);
        if (!requiredOps.includes(op)) continue;
        if (JSON.stringify(input).includes(identifier)) return true;
      } else if (block.type === 'tool_result') {
        const op = idToOperation.get(block.tool_use_id);
        if (op == null || !requiredOps.includes(op)) continue;
        const result = block.content;
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultStr.includes(identifier)) return true;
      }
    }
  }
  return false;
}

// ── Chaining an exact position across LSP calls ─────────────────────────
// goToDefinition/findReferences/etc. take a real filePath+line+character,
// which a hook never has directly from a Grep/Bash pattern. But once
// *any* prior LSP call this session (workspaceSymbol, documentSymbol, ...)
// has already surfaced `identifier`'s file:line in its result text, that's
// enough to hand the next suggestion a fully concrete call — no need to
// make the agent Read the file and guess a character offset (observed
// directly: a first findReferences attempt failed with "no identifier
// found" on a guessed column, before a retry with a different guess
// succeeded). The native tool's own result text always uses the form
// "<Symbol> (<Kind>) - Line <N>"; multi-file results (workspaceSymbol)
// additionally list the owning file as a bare "path/to/file.ext:" header
// line above the matches it contains.

const SYMBOL_LINE_RE_SOURCE = '\\((?:[A-Za-z]+)\\)\\s*-\\s*Line\\s*(\\d+)';
const FILE_HEADER_RE = /^\s{0,4}(\S[^:\s]*\.[A-Za-z0-9]+):\s*$/;

/**
 * Find the line number of `identifier`'s entry in a prior LSP result
 * already in the transcript, together with the file it's in — from a
 * multi-file (workspaceSymbol) result's own file-header lines, or from
 * `filePathHint` when the result was already scoped to one file
 * (documentSymbol). Deliberately conservative: returns null on anything
 * that doesn't clearly match rather than guessing.
 */
function findKnownLine(transcriptPath, identifier, filePathHint) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  const esc = String(identifier).replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
  const symbolLineRe = new RegExp(`\\b${esc}\\b\\s*${SYMBOL_LINE_RE_SOURCE}`);

  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return null;
  }

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      const result = block.content;
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      if (!symbolLineRe.test(resultStr)) continue;

      let currentFile = filePathHint || null;
      for (const rl of resultStr.split('\n')) {
        const headerMatch = rl.match(FILE_HEADER_RE);
        if (headerMatch) { currentFile = headerMatch[1].trim(); continue; }
        const m = rl.match(symbolLineRe);
        if (m && currentFile) return { filePath: currentFile, line: Number(m[1]) };
      }
    }
  }
  return null;
}

/**
 * Read the exact character offset (1-based) of `identifier`'s first
 * word-boundary occurrence on a known line of a real file — replaces
 * having the agent Read the file and eyeball a column itself. Returns
 * null (never throws) if the file/line/identifier don't line up.
 */
function resolveCharacterOffset(filePath, line, identifier) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').split('\n')[line - 1];
    if (text == null) return null;
    const esc = String(identifier).replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
    const m = text.match(new RegExp(`\\b${esc}\\b`));
    return m ? m.index + 1 : null;
  } catch {
    return null;
  }
}

/**
 * Combine the two above into a ready-to-use exact position for
 * `identifier`, if a prior LSP result in the transcript already located
 * it. Returns { filePath, line, character } or null.
 */
function resolveKnownPosition(transcriptPath, identifier, filePathHint) {
  const known = findKnownLine(transcriptPath, identifier, filePathHint);
  if (!known) return null;
  const character = resolveCharacterOffset(known.filePath, known.line, identifier);
  if (character == null) return null;
  return { filePath: known.filePath, line: known.line, character };
}

/**
 * Build a suggestion line for a given symbol and navigation intent,
 * pointed at the native `LSP` tool. Most operations stay advisory
 * phrasing — the native tool requires filePath/line/character, and a
 * grep/glob/sed pattern match alone doesn't tell us a real position to
 * hand goToDefinition/findReferences/etc. `workspaceSymbol` is the one
 * exception: it takes a `query` instead of a real position, so any real
 * source file works as its required filePath anchor. When it's among the
 * suggested ops, resolve one (via `anchorHint`, e.g. the blocked Grep's
 * own `path` param) and give a copy-pasteable call instead of just
 * naming the operation — this is what removes the multi-turn anchor-file
 * hunt seen in practice.
 *
 * Before falling back to advisory phrasing for a positional op
 * (goToDefinition/findReferences/...), check whether `transcriptPath`
 * already has an exact position for `symbol` from an earlier LSP result
 * this session (e.g. a workspaceSymbol call that satisfied a different
 * required op) — if so, hand back that fully concrete call instead.
 */
function buildSuggestion(symbol, intent, indent = '  ', anchorHint, transcriptPath) {
  const ops = NATIVE_OPERATIONS[intent] || NATIVE_OPERATIONS.bare;
  const advisory = `${indent}LSP tool — operation: ${ops.join(' or ')} (for "${symbol}")`;

  const positionalOp = ops.find(o => o !== 'workspaceSymbol');
  if (positionalOp && transcriptPath) {
    const known = resolveKnownPosition(transcriptPath, symbol);
    if (known) {
      const safeFile = String(known.filePath).replace(/"/g, '\\"');
      const safeSymbol = String(symbol).replace(/"/g, '\\"');
      return `${indent}LSP tool: operation "${positionalOp}", filePath "${safeFile}", line ${known.line}, character ${known.character} (for "${safeSymbol}")\n` +
             `${indent}  (exact position resolved from an earlier LSP result this session — no need to Read and guess a column)`;
    }
  }

  if (!ops.includes('workspaceSymbol')) return advisory;

  const anchor = resolveAnchorFile(anchorHint);
  if (!anchor) return advisory;

  const safeFile = String(anchor).replace(/"/g, '\\"');
  const safeSymbol = String(symbol).replace(/"/g, '\\"');
  const concrete =
    `${indent}LSP tool: operation "workspaceSymbol", filePath "${safeFile}", line 1, character 1, query "${safeSymbol}"\n` +
    `${indent}  (any file works as the anchor here — workspaceSymbol searches the whole workspace, not just this file)`;
  return ops.length === 1 ? concrete : `${advisory}\n${concrete}\n${indent}  ↑ recommended first: workspaceSymbol is the only one of these that doesn't need a position you don't have yet`;
}

/**
 * Warmup instructions for Gate 1 in lsp-first-read-guard.js, with no
 * concrete file known yet. Any successful `LSP` call satisfies this
 * (lsp-usage-tracker.js sets warmup_done on the first one regardless of
 * `operation`) — documentSymbol on an arbitrary file is offered only as
 * the cheapest option when the agent doesn't already know what it's
 * looking for. If it does, it should aim its first call at that instead
 * of spending one on a throwaway.
 */
function buildWarmupInstructions(indent = '  ') {
  return [
    `${indent}Any successful LSP call unlocks this — if you already know what symbol you need, aim your first LSP call at that directly (it satisfies warmup too).`,
    `${indent}Otherwise, the cheapest option: LSP tool, operation "documentSymbol", on any project file.`,
    `${indent}  → lists the file's symbols and counts as warmup (position is ignored by this operation).`,
  ];
}

/**
 * Copy-pasteable warmup call parametrized by the actual file the agent
 * is about to Read — the one case where a concrete filePath IS known, so
 * a real call (not just advisory phrasing) can be given. documentSymbol
 * ignores line/character, so 1/1 is just an anchor value the schema
 * requires.
 */
function buildFileWarmupCall(filePath, indent = '  ') {
  if (!filePath) return '';
  const safeFile = String(filePath).replace(/"/g, '\\"');
  return `${indent}LSP tool: operation "documentSymbol", filePath "${safeFile}", line 1, character 1`;
}

/**
 * Build a structured suggestion object for programmatic consumers
 * (monitoring, dashboards, IDE plugins).
 */
function buildStructuredSuggestions(symbol, intent) {
  const ops = NATIVE_OPERATIONS[intent] || NATIVE_OPERATIONS.bare;
  return [{
    tool: 'LSP',
    operations: ops,
    query: String(symbol),
    displayTool: `LSP tool — operation: ${ops.join(' or ')} (for "${symbol}")`,
  }];
}

/**
 * Assemble a structured block response that blocking hooks can emit via
 * console.log(JSON.stringify(...)). Keeps `decision`/`reason` fields
 * intact (backward compatible with existing consumers).
 */
function buildStructuredBlockResponse({ hook, symbols, intent, reason }) {
  const suggestions = [];
  const symbolList = Array.isArray(symbols) ? symbols : [];
  for (const sym of symbolList) {
    for (const s of buildStructuredSuggestions(sym, intent)) {
      suggestions.push({ symbol: String(sym), ...s });
    }
  }
  return {
    decision: 'block',
    reason:   String(reason ?? ''),
    hook:     String(hook ?? ''),
    symbols:  symbolList.map(String),
    intent:   String(intent ?? ''),
    suggestions,
  };
}

module.exports = {
  NATIVE_OPERATIONS,
  REQUIRED_OPS_BY_SHAPE,
  classifySymbolShape,
  findDeclarationOrCallsite,
  isLspSatisfied,
  resolveAnchorFile,
  resolveKnownPosition,
  buildSuggestion,
  buildWarmupInstructions,
  buildFileWarmupCall,
  buildStructuredSuggestions,
  buildStructuredBlockResponse,
};
