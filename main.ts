// Driver for the markdown-render-speed-02 harness.
// Reads the case set, renders every case independently with parse(),
// and writes the HTML strings in the same order.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

function loadCases(raw: string): string[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('cases.json must be a JSON array');
  }
  const texts: string[] = [];
  for (const entry of data as unknown[]) {
    if (typeof entry === 'string') {
      texts.push(entry);
    } else if (entry !== null && typeof entry === 'object' && typeof (entry as { markdown?: unknown }).markdown === 'string') {
      texts.push((entry as { markdown: string }).markdown);
    } else {
      throw new Error('each case must be a string or an object with a markdown string');
    }
  }
  return texts;
}

function main(): void {
  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = loadCases(raw);
  const html: string[] = new Array<string>(cases.length);
  for (let idx = 0; idx < cases.length; idx++) {
    html[idx] = parse(cases[idx]);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
