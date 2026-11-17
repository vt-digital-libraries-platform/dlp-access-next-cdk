import * as readline from "readline";

/** Asks a question on the terminal; a closed stdin (Ctrl-D, or no terminal) answers "". */
export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.once("close", () => resolve(""));
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

/** Bold red on a terminal; plain text otherwise. */
export function alert(text: string): string {
  return process.stdout.isTTY ? `\x1b[1;31m${text}\x1b[0m` : text;
}
