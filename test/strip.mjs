import {readFileSync} from 'node:fs';
const s = readFileSync(process.argv[2], 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*$\n/gm, '');
process.stdout.write(s);
