const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/bot.ts');
const code = fs.readFileSync(filePath, 'utf8');
let lines = code.split('\n');

let startLineIdx = -1;
let endLineIdx = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// ── BallBackTest JSON Export')) {
    startLineIdx = i; // this is line index 2053 (0-indexed)
    break;
  }
}

for (let i = startLineIdx; i < lines.length; i++) {
  // Find the end of the handler by looking for the `});`
  if (lines[i].includes('});') && lines[i-1].trim() === '}') {
    endLineIdx = i - 1; // this is the index of `  }` at 2491
    break;
  }
}

if (startLineIdx === -1 || endLineIdx === -1) {
  console.error("Could not find start or end index");
  process.exit(1);
}

// 1. Insert `  }` at startLineIdx
lines.splice(startLineIdx, 0, '  }');

startLineIdx++; // Adjust pointer to point to the BallBackTest JSON Export line
endLineIdx++; // Adjust pointer for the shifted array

// 2. Un-indent lines from startLineIdx up to endLineIdx (exclusive or inclusive? up to the `  }` that we need to remove)
// wait, endLineIdx points to the `  }` at the end.
for (let i = startLineIdx; i < endLineIdx; i++) {
  if (lines[i].startsWith('  ')) {
    lines[i] = lines[i].substring(2);
  }
}

// 3. Remove the extra closing brace at endLineIdx
lines.splice(endLineIdx, 1);

fs.writeFileSync(filePath, lines.join('\n'));
console.log('Successfully fixed bot.ts');
