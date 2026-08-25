import { writeFileSync } from 'node:fs';

export function writeFakeClaudeCli(
  scriptPath: string,
  options: { responseText: string; version?: string }
): void {
  const version = options.version ?? '1.0.0';

  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: options.responseText,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    },
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 10, outputTokens: 20 }
    }
  });

  const source = `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (args[0] === '-p') {
  readFileSync(0, 'utf8');
  console.log(${JSON.stringify(envelope)});
  process.exit(0);
}
process.exit(2);
`;

  writeFileSync(scriptPath, source, 'utf8');
}
