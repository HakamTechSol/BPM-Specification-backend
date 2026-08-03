#!/usr/bin/env node
/**
 * Post-build obfuscation step.
 *
 * Walks dist/ and overwrites every .js file with an obfuscated version.
 * Settings are deliberately moderate: enough to obscure the source without
 * breaking runtime behaviour (no control-flow flattening, no dead-code
 * injection, no self-defending wrapper, no global renaming).
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const OBJFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  controlFlowFlatteningThreshold: 0,
  deadCodeInjection: false,
  deadCodeInjectionThreshold: 0,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function obfuscateFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(source, OBJFUSCATOR_OPTIONS);
  fs.writeFileSync(file, result.getObfuscatedCode(), 'utf8');
  return source.length;
}

if (!fs.existsSync(DIST_DIR)) {
  console.error(`dist/ not found at ${DIST_DIR}. Run "npm run build" first.`);
  process.exit(1);
}

const files = walk(DIST_DIR);
if (files.length === 0) {
  console.log('No .js files found in dist/. Nothing to obfuscate.');
  process.exit(0);
}

let totalBytes = 0;
for (const file of files) {
  const before = obfuscateFile(file);
  totalBytes += before;
  const relative = path.relative(DIST_DIR, file);
  console.log(`Obfuscated ${relative} (${(before / 1024).toFixed(1)} KB)`);
}

console.log(`\nObfuscated ${files.length} files (${(totalBytes / 1024).toFixed(1)} KB total).`);
