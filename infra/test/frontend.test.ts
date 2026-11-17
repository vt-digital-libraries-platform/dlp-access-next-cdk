import { Command, RunnerOptions } from "../lib/command-runner";
import { SOLUTION_STACK } from "../lib/config/web";
import { planFrontend } from "../lib/frontend/frontend";
import { FrontendIO, frontendDeploy } from "../lib/frontend/frontend-cli";
import { fakeRunner } from "./fake-runner";

const awsAccountId = "123456789012";

describe("planFrontend", () => {
  test("derives the frontend's names from the backend env and branch", () => {
    const plan = planFrontend({
      backendEnv: "dev",
      branch: "whunter/Multi_Env",
      awsAccountId,
    });
    expect(plan).toMatchObject({
      backendEnv: "dev",
      region: "us-east-1",
      awsAccountId,
      production: false,
      instanceType: "t3.small",
      branch: "whunter/Multi_Env",
      slug: "whunter-multi-env",
      environmentName: "dlpnext-whunter-multi-env",
      domainName: "whunter-multi-env.dlp-access-dev.dlp.cloud.lib.vt.edu",
      appUrl: "https://whunter-multi-env.dlp-access-dev.dlp.cloud.lib.vt.edu",
      certificate:
        "arn:aws:acm:us-east-1:123456789012:certificate/3163b25c-b6f5-4b23-8569-514064db7767",
      secretName: "dlpnext/whunter-multi-env/cognito-client-secret",
    });
  });

  test("--production picks the larger instance type", () => {
    expect(
      planFrontend({
        backendEnv: "dev",
        branch: "main",
        awsAccountId,
        production: true,
      }),
    ).toMatchObject({ production: true, instanceType: "t3.medium" });
  });

  test("--certificate overrides the default certificate", () => {
    const certificate = `arn:aws:acm:us-east-1:${awsAccountId}:certificate/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7`;
    expect(
      planFrontend({
        backendEnv: "f-search",
        branch: "main",
        awsAccountId,
        certificate,
      }),
    ).toMatchObject({ backendEnv: "f-search", certificate });
  });

  test.each([
    [{ backendEnv: undefined }, /Missing .*backend-env/],
    [{ backendEnv: "staging" }, /Unknown environment "staging"/],
    [{ backendEnv: "Dev" }, /Invalid environment name "Dev"/],
    [{ branch: "///" }, /Invalid branch "\/\/\/".*--branch/],
    [{ branch: "a".repeat(33) }, /Invalid branch "a{33}".*1 to 32 characters/],
    [
      { branch: "main\u001b[2K" },
      /Invalid branch "main\\u001b\[2K": a git branch name has no control characters/,
    ],
    [{ certificate: "not-an-arn" }, /Invalid certificate "not-an-arn"/],
    [
      {
        certificate:
          "arn:aws:acm:us-west-2:123456789012:certificate/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7",
      },
      /must be in account 123456789012 and us-east-1/,
    ],
    [
      {
        certificate:
          "arn:aws:acm:us-east-1:210987654321:certificate/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7",
      },
      /must be in account 123456789012 and us-east-1/,
    ],
  ])("rejects %p", (override, error) => {
    expect(() =>
      planFrontend({
        backendEnv: "dev",
        branch: "main",
        awsAccountId,
        ...override,
      }),
    ).toThrow(error);
  });
});

describe("frontendDeploy", () => {
  const serviceRoleArn = `arn:aws:iam::${awsAccountId}:role/dlp-access-next-dev-eb-service`;

  /**
   * Fakes the AWS, EB and git state. `appExists` says whether dlpnext exists
   * yet, and `hasPolicy` whether it has its version lifecycle policy.
   */
  function setup({
    appExists = false,
    hasPolicy = true,
    answer = "yes",
    branch = "whunter/feature",
    status = "",
  }: {
    appExists?: boolean;
    hasPolicy?: boolean;
    answer?: string;
    branch?: string;
    status?: string;
  } = {}) {
    const run = fakeRunner(({ executable, args }) => {
      const command = [executable, ...args].join(" ");
      if (command === "git branch --show-current") return `${branch}\n`;
      if (command === "git rev-parse --verify HEAD")
        return "0123456789abcdef0123456789abcdef01234567\n";
      if (command === "git status --porcelain") return status;
      if (command === "aws sts get-caller-identity")
        return JSON.stringify({ Account: awsAccountId });
      if (
        command ===
        "aws elasticbeanstalk describe-applications --application-names dlpnext"
      )
        return JSON.stringify({
          Applications: appExists
            ? [
                {
                  ApplicationName: "dlpnext",
                  ResourceLifecycleConfig: {
                    VersionLifecycleConfig: {
                      MaxCountRule: {
                        Enabled: hasPolicy,
                        MaxCount: 200,
                        DeleteSourceFromS3: true,
                      },
                    },
                  },
                },
              ]
            : [],
        });
      if (
        command ===
        "aws ssm get-parameter --name /dlp-access-next/dev/eb-service-role-arn"
      )
        return JSON.stringify({ Parameter: { Value: serviceRoleArn } });
      if (executable === "eb" && args[0] === "init") return "";
      if (
        command.startsWith(
          "aws elasticbeanstalk update-application-resource-lifecycle",
        )
      )
        return "{}";
      throw new Error(`unexpected command: ${command}`);
    });
    const runnerOptions: RunnerOptions[] = [];
    const questions: string[] = [];
    const output: string[] = [];
    const io: { -readonly [K in keyof FrontendIO]: FrontendIO[K] } = {
      alert: (text) => text,
      runner: (options) => {
        runnerOptions.push(options);
        return run;
      },
      ask: async (question) => {
        questions.push(question);
        return answer;
      },
      log: (text) => output.push(text),
    };
    return { run, io, runnerOptions, questions, output };
  }

  const writes = (commands: Command[]) =>
    commands.filter(
      ({ executable, args }) =>
        executable === "eb" ||
        (executable === "aws" &&
          /^(create|update|delete|put)-/.test(args[1] ?? "")),
    );

  test("creates the dlpnext application with the lifecycle policy when it is new", async () => {
    const { run, io, runnerOptions } = setup();

    expect(
      await frontendDeploy(
        ["--backend-env", "dev", "--profile", "dlp"],
        undefined,
        io,
      ),
    ).toBe(0);

    expect(runnerOptions).toEqual([{ region: "us-east-1", profile: "dlp" }]);
    expect(writes(run.commands)).toEqual([
      {
        executable: "eb",
        args: ["init", "dlpnext", "--platform", SOLUTION_STACK],
      },
      {
        executable: "aws",
        args: [
          "elasticbeanstalk",
          "update-application-resource-lifecycle",
          "--application-name",
          "dlpnext",
          "--resource-lifecycle-config",
          expect.any(String),
        ],
      },
    ]);
    const lifecycle = JSON.parse(writes(run.commands)[1].args[5]);
    expect(lifecycle).toEqual({
      ServiceRole: serviceRoleArn,
      VersionLifecycleConfig: {
        MaxCountRule: {
          Enabled: true,
          MaxCount: 200,
          DeleteSourceFromS3: true,
        },
      },
    });
  });

  test("an existing application only gets eb init, with no lifecycle change", async () => {
    const { run, io } = setup({ appExists: true });

    expect(await frontendDeploy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );

    expect(writes(run.commands)).toEqual([
      {
        executable: "eb",
        args: ["init", "dlpnext", "--platform", SOLUTION_STACK],
      },
    ]);
  });

  test("an existing application without the lifecycle policy gets it, e.g. after a failed first run", async () => {
    const { run, io } = setup({ appExists: true, hasPolicy: false });

    expect(await frontendDeploy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );

    expect(writes(run.commands).map(({ args }) => args[1] ?? args[0])).toEqual([
      "dlpnext",
      "update-application-resource-lifecycle",
    ]);
  });

  test.each(["", "no", "n", "yess"])(
    "answering %p changes nothing",
    async (answer) => {
      const { run, io, questions, output } = setup({ answer });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(1);

      expect(questions).toHaveLength(1);
      expect(writes(run.commands)).toEqual([]);
      expect(output).toContain("Not deployed.");
    },
  );

  test("prints the plan, the commit and the uncommitted changes left out, before asking", async () => {
    const { io, output } = setup({
      status: " M src/app/page.tsx\n?? notes.txt\n",
    });

    await frontendDeploy(["--backend-env", "dev"], undefined, io);

    const printed = output.join("\n");
    expect(printed).toMatch(/dlpnext-whunter-feature/);
    expect(printed).toMatch(/https:\/\/whunter-feature\.dlp-access-dev/);
    expect(printed).toMatch(/commit 0123456789abcdef0123456789abcdef01234567/);
    expect(printed).toMatch(
      /Uncommitted changes are not deployed:\n {3}M src\/app\/page.tsx\n {2}\?\? notes.txt/,
    );
  });

  test("--branch overrides the current git branch", async () => {
    const { run, io, output } = setup();

    await frontendDeploy(
      ["--backend-env", "dev", "--branch", "other/Thing"],
      undefined,
      io,
    );

    expect(run.commands).not.toContainEqual({
      executable: "git",
      args: ["branch", "--show-current"],
    });
    expect(output.join("\n")).toMatch(/dlpnext-other-thing/);
  });

  test("refuses a detached HEAD without --branch, before changing anything", async () => {
    const { run, io } = setup({ branch: "" });

    await expect(
      frontendDeploy(["--backend-env", "dev"], undefined, io),
    ).rejects.toThrow(/--branch/);
    expect(writes(run.commands)).toEqual([]);
  });

  test("the production backend gets a highlighted warning and question", async () => {
    const { io, questions, output } = setup({ appExists: true });
    io.alert = (text) => `<red>${text}</red>`;
    // The fake only knows the dev service role; production's app already exists.

    await frontendDeploy(["--backend-env", "production"], undefined, io);

    expect(output.join("\n")).toMatch(
      /<red>!+\n!! {2}WARNING: THIS DEPLOYS TO THE PRODUCTION ENVIRONMENT[\s\S]*--production is not set/,
    );
    expect(questions).toEqual([
      '<red>Deploy to PRODUCTION? Type "yes" or "y" to continue: </red>',
    ]);
  });

  test("--yes in CI skips the prompt", async () => {
    const { run, io, questions } = setup({ appExists: true, answer: "no" });

    expect(
      await frontendDeploy(["--backend-env", "dev", "--yes"], "true", io),
    ).toBe(0);

    expect(questions).toEqual([]);
    expect(writes(run.commands)).toHaveLength(1);
  });

  test("--yes outside CI is refused before any command runs", async () => {
    const { run, io } = setup();

    await expect(
      frontendDeploy(["--backend-env", "dev", "-y"], undefined, io),
    ).rejects.toThrow(/only applies in CI/);
    expect(run.commands).toEqual([]);
  });

  test.each([
    [[], /Missing backend env: pass --backend-env <env>/],
    [["--backend-env", ""], /Missing backend env: pass --backend-env <env>/],
    [["--backend-env", "dev", "--bogus"], /Unknown option '--bogus'/],
  ])("rejects the arguments %p", async (argv, error) => {
    const { io } = setup();
    await expect(frontendDeploy(argv, undefined, io)).rejects.toThrow(error);
  });
});
