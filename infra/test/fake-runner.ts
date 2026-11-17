import { Command, CommandRunner } from "../lib/command-runner";

/** A fake runner that records every command it is given, in order. */
export type FakeRunner = CommandRunner & { readonly commands: Command[] };

/**
 * A fake command runner: `respond` returns a command's stdout, or throws a
 * `CommandError` to simulate a non-zero exit. Every command is recorded in
 * `commands` before `respond` sees it, so failed ones are recorded too.
 */
export function fakeRunner(respond: (command: Command) => string): FakeRunner {
  const commands: Command[] = [];
  const run: CommandRunner = (executable, args) => {
    const command = { executable, args: [...args] };
    commands.push(command);
    return respond(command);
  };
  return Object.assign(run, { commands });
}
