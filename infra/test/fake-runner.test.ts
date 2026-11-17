import { CommandError } from "../lib/command-runner";
import { fakeRunner } from "./fake-runner";

describe("fakeRunner", () => {
  test("records every command it is given, in order, including ones that fail", () => {
    const run = fakeRunner(({ executable, args }) => {
      if (executable === "eb") {
        throw new CommandError("eb", 4, "ERROR: NotFoundError");
      }
      return `${executable} ${args.join(" ")}`;
    });

    expect(run("git", ["rev-parse", "HEAD"])).toBe("git rev-parse HEAD");
    expect(() => run("eb", ["status", "dlpnext-x"])).toThrow(CommandError);
    run("aws", ["sts", "get-caller-identity"]);

    expect(run.commands).toEqual([
      { executable: "git", args: ["rev-parse", "HEAD"] },
      { executable: "eb", args: ["status", "dlpnext-x"] },
      { executable: "aws", args: ["sts", "get-caller-identity"] },
    ]);
  });
});
