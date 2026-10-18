import { createRequire } from 'node:module';

interface Cli {
  help: string;
}
interface SharedCli {
  CliHelp: new (message: string) => Error;
  defineCli: (usage: string, names?: string[]) => Cli;
  parseCli: (
    argv: string[],
    cli: Cli,
  ) => {
    options: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
  cliError: (cli: Cli, message: string) => Error;
}

// Resolve from the workspace package so source and compiled utilities share one CLI.
const requireFromWorkspace = createRequire(
  require.resolve('@mcc/match-to-csv/package.json'),
);
export const { CliHelp, defineCli, parseCli, cliError } = requireFromWorkspace(
  '../../scripts/cli.cjs',
) as SharedCli;
