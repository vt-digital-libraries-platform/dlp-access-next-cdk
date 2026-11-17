import * as fs from "fs";
import { Command, CommandError, RunnerOptions } from "../lib/command-runner";
import { SOLUTION_STACK } from "../lib/config/web";
import { planFrontend } from "../lib/frontend/frontend";
import { FrontendIO, frontendDeploy } from "../lib/frontend/frontend-cli";
import { committedOptions } from "./committed-options";
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
    [
      { branch: "fix#12" },
      /Invalid branch "fix#12": .*letters, digits, spaces and _ \. : \/ = \+ - @/,
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
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const userPoolId = "us-east-1_AbCdEfGhI";
  const secretArn = `arn:aws:secretsmanager:us-east-1:${awsAccountId}:secret:dlpnext/whunter-feature/cognito-client-secret-AbCdEf`;
  const bucket = `elasticbeanstalk-us-east-1-${awsAccountId}`;

  /** The value after `flag` in `args`. */
  const flagValue = (args: readonly string[], name: string) =>
    args[args.indexOf(name) + 1];

  /**
   * Fakes the AWS, EB and git state, and changes it as commands create
   * things. `appExists` says whether dlpnext exists yet, and `hasPolicy`
   * whether it has its version lifecycle policy.
   */
  function setup({
    appExists = false,
    hasPolicy = true,
    answer = "yes",
    branch = "whunter/feature",
    status = "",
    clients = [] as { ClientId: string; ClientName: string }[],
    secretExists = false,
    versionExists = false,
    environmentExists = false,
    launchingWaits = 0,
    health = "Green",
    previouslyTerminated = false,
  } = {}) {
    let environment = environmentExists
      ? { Status: "Ready", Health: health }
      : undefined;
    let waitsLeft = launchingWaits;
    const secretStrings: string[] = [];
    const parameters: Record<string, string> = {
      "/dlp-access-next/dev/eb-service-role-arn": serviceRoleArn,
      "/dlp-access-next/dev/graphql-api-url":
        "https://abc.appsync-api.us-east-1.amazonaws.com/graphql",
      "/dlp-access-next/dev/user-pool-id": userPoolId,
      "/dlp-access-next/dev/identity-provider": "VTGateway",
    };
    const json = (value: unknown) => JSON.stringify(value);
    const run = fakeRunner(({ executable, args }) => {
      const command = [executable, ...args].join(" ");
      if (command === "git branch --show-current") return `${branch}\n`;
      if (command === "git rev-parse --verify HEAD") return `${commit}\n`;
      if (command === "git status --porcelain") return status;
      if (executable === "git" && args[0] === "archive") return "";
      if (executable === "eb" && args[0] === "init") return "";
      if (executable !== "aws") {
        throw new Error(`unexpected command: ${command}`);
      }
      const name = flagValue(args, "--name");
      switch (`${args[0]} ${args[1]}`) {
        case "sts get-caller-identity":
          return json({ Account: awsAccountId });
        case "ssm get-parameter":
          if (!(name in parameters)) {
            throw new CommandError("aws", 254, "ParameterNotFound");
          }
          return json({ Parameter: { Value: parameters[name] } });
        case "elasticbeanstalk describe-applications":
          return json({
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
        case "elasticbeanstalk update-application-resource-lifecycle":
          return "{}";
        case "cognito-idp list-user-pool-clients":
          return json({
            UserPoolClients: clients.map((client) => ({
              ...client,
              UserPoolId: userPoolId,
            })),
          });
        case "cognito-idp describe-user-pool-client":
          return json({
            UserPoolClient: {
              ClientId: flagValue(args, "--client-id"),
              ClientSecret: "existing-secret",
            },
          });
        case "cognito-idp create-user-pool-client":
          return json({
            UserPoolClient: {
              ClientId: "newclientid",
              ClientSecret: "new-secret",
            },
          });
        case "secretsmanager list-secrets":
          return json({
            SecretList: secretExists
              ? [
                  {
                    ARN: secretArn,
                    Name: "dlpnext/whunter-feature/cognito-client-secret",
                  },
                ]
              : [],
          });
        case "secretsmanager create-secret":
        case "secretsmanager put-secret-value": {
          // Read while the command runs: the file is gone afterwards.
          const source = flagValue(args, "--secret-string");
          expect(source).toMatch(/^file:\/\//);
          secretStrings.push(
            fs.readFileSync(source.slice("file://".length), "utf8"),
          );
          return json({ ARN: secretArn });
        }
        case "elasticbeanstalk describe-application-versions":
          return json({
            ApplicationVersions: versionExists
              ? [{ VersionLabel: flagValue(args, "--version-labels") }]
              : [],
          });
        case "elasticbeanstalk create-storage-location":
          return json({ S3Bucket: bucket });
        case "s3 cp":
          return "";
        case "elasticbeanstalk create-application-version":
          return "{}";
        case "elasticbeanstalk describe-environments":
          return json({
            Environments: environment
              ? [
                  {
                    EnvironmentName: "dlpnext-whunter-feature",
                    CNAME:
                      "dlpnext-whunter-feature.us-east-1.elasticbeanstalk.com",
                    ...environment,
                  },
                ]
              : [],
          });
        case "elasticbeanstalk create-environment":
          environment = { Status: "Launching", Health: "Grey" };
          return "{}";
        case "elasticbeanstalk wait":
          // A terminated namesake isn't Ready, so the waiter can't succeed
          // unless it leaves deleted environments out.
          if (previouslyTerminated && !args.includes("--no-include-deleted")) {
            throw new CommandError(
              "aws",
              255,
              "Waiter EnvironmentExists failed: Max attempts exceeded",
            );
          }
          if (waitsLeft > 0) {
            waitsLeft--;
            throw new CommandError(
              "aws",
              255,
              "Waiter EnvironmentExists failed: Max attempts exceeded",
            );
          }
          environment = { Status: "Ready", Health: health };
          return "";
        case "route53 list-hosted-zones-by-name":
          return json({
            HostedZones: [
              {
                Id: "/hostedzone/ZPRIVATE",
                Name: "dlp.cloud.lib.vt.edu.",
                Config: { PrivateZone: true },
              },
              {
                Id: "/hostedzone/Z0123456789",
                Name: "dlp.cloud.lib.vt.edu.",
                Config: { PrivateZone: false },
              },
              {
                Id: "/hostedzone/ZOTHER",
                Name: "other.lib.vt.edu.",
                Config: { PrivateZone: false },
              },
            ],
          });
        case "route53 change-resource-record-sets":
          return "{}";
      }
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
    return { run, io, runnerOptions, questions, output, secretStrings };
  }

  /** The commands that change something in AWS. */
  const writes = (commands: Command[]) =>
    commands.filter(
      ({ executable, args }) =>
        executable === "eb" ||
        (executable === "aws" &&
          (args[0] === "s3" ||
            /^(create|update|delete|put|change)-/.test(args[1] ?? ""))),
    );

  /** The commands that set up the shared application. */
  const applicationSetup = (commands: Command[]) =>
    commands.filter(
      ({ executable, args }) =>
        executable === "eb" ||
        args[1] === "update-application-resource-lifecycle",
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
    expect(applicationSetup(run.commands)).toEqual([
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
    const lifecycle = JSON.parse(applicationSetup(run.commands)[1].args[5]);
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

    expect(applicationSetup(run.commands)).toEqual([
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

    expect(
      applicationSetup(run.commands).map(({ args }) => args[1] ?? args[0]),
    ).toEqual(["dlpnext", "update-application-resource-lifecycle"]);
  });

  describe("a first deploy", () => {
    const appUrl =
      "https://whunter-feature.dlp-access-dev.dlp.cloud.lib.vt.edu";
    const clientSettings = [
      "--user-pool-id",
      userPoolId,
      "--client-name",
      "dlpnext-whunter-feature",
      "--generate-secret",
      "--allowed-o-auth-flows-user-pool-client",
      "--allowed-o-auth-flows",
      "code",
      "--allowed-o-auth-scopes",
      "openid",
      "email",
      "--supported-identity-providers",
      "VTGateway",
      "--callback-urls",
      `${appUrl}/authorize`,
      "http://localhost:3000/authorize",
      "--logout-urls",
      `${appUrl}/`,
      "http://localhost:3000/",
    ];

    /** The option settings `create-environment` was given. */
    const optionSettings = (commands: Command[]) => {
      const create = commands.find(
        ({ args }) => args[1] === "create-environment",
      );
      return JSON.parse(flagValue(create!.args, "--option-settings"));
    };

    test("creates the client, the secret, the environment and the DNS record", async () => {
      const { run, io, secretStrings } = setup();

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      const created = writes(run.commands).filter(
        (command) => !applicationSetup([command]).length,
      );
      expect(created).toEqual([
        {
          executable: "aws",
          args: ["cognito-idp", "create-user-pool-client", ...clientSettings],
        },
        {
          executable: "aws",
          args: [
            "secretsmanager",
            "create-secret",
            "--name",
            "dlpnext/whunter-feature/cognito-client-secret",
            "--description",
            expect.any(String),
            "--secret-string",
            expect.stringMatching(/^file:\/\//),
          ],
        },
        {
          executable: "aws",
          args: ["elasticbeanstalk", "create-storage-location"],
        },
        {
          executable: "aws",
          args: [
            "s3",
            "cp",
            expect.stringMatching(/\.zip$/),
            `s3://${bucket}/dlpnext/whunter-feature-0123456.zip`,
          ],
        },
        {
          executable: "aws",
          args: [
            "elasticbeanstalk",
            "create-application-version",
            "--application-name",
            "dlpnext",
            "--version-label",
            "whunter-feature-0123456",
            "--description",
            expect.stringContaining(commit),
            "--source-bundle",
            `S3Bucket=${bucket},S3Key=dlpnext/whunter-feature-0123456.zip`,
          ],
        },
        {
          executable: "aws",
          args: [
            "elasticbeanstalk",
            "create-environment",
            "--application-name",
            "dlpnext",
            "--environment-name",
            "dlpnext-whunter-feature",
            "--cname-prefix",
            "dlpnext-whunter-feature",
            "--version-label",
            "whunter-feature-0123456",
            "--solution-stack-name",
            SOLUTION_STACK,
            "--tags",
            expect.any(String),
            "--option-settings",
            expect.any(String),
          ],
        },
        {
          executable: "aws",
          args: [
            "route53",
            "change-resource-record-sets",
            "--hosted-zone-id",
            "Z0123456789",
            "--change-batch",
            expect.any(String),
          ],
        },
      ]);
      expect(secretStrings).toEqual(["new-secret"]);

      const createEnvironment = created[5].args;
      expect(JSON.parse(flagValue(createEnvironment, "--tags"))).toEqual([
        { Key: "dlpnext:branch", Value: "whunter/feature" },
        { Key: "dlpnext:backend-env", Value: "dev" },
      ]);
      expect(optionSettings(run.commands)).toEqual([
        {
          Namespace: "aws:elasticbeanstalk:environment",
          OptionName: "EnvironmentType",
          Value: "LoadBalanced",
        },
        {
          Namespace: "aws:elasticbeanstalk:environment",
          OptionName: "LoadBalancerType",
          Value: "application",
        },
        {
          Namespace: "aws:elbv2:listener:443",
          OptionName: "SSLCertificateArns",
          Value: `arn:aws:acm:us-east-1:${awsAccountId}:certificate/3163b25c-b6f5-4b23-8569-514064db7767`,
        },
        {
          Namespace: "aws:autoscaling:launchconfiguration",
          OptionName: "IamInstanceProfile",
          Value: "dlp-access-next-dev-eb",
        },
        {
          Namespace: "aws:elasticbeanstalk:environment",
          OptionName: "ServiceRole",
          Value: serviceRoleArn,
        },
        {
          Namespace: "aws:ec2:instances",
          OptionName: "InstanceTypes",
          Value: "t3.small",
        },
        ...Object.entries({
          APPSYNC_API_URL:
            "https://abc.appsync-api.us-east-1.amazonaws.com/graphql",
          AWS_REGION: "us-east-1",
          COGNITO_ISSUER: `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`,
          COGNITO_CLIENT_ID: "newclientid",
          COGNITO_IDENTITY_PROVIDER: "VTGateway",
          APP_BASE_URL: appUrl,
        }).map(([OptionName, Value]) => ({
          Namespace: "aws:elasticbeanstalk:application:environment",
          OptionName,
          Value,
        })),
        {
          Namespace: "aws:elasticbeanstalk:application:environmentsecrets",
          OptionName: "COGNITO_CLIENT_SECRET",
          Value: secretArn,
        },
      ]);
      expect(JSON.parse(flagValue(created[6].args, "--change-batch"))).toEqual({
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: "whunter-feature.dlp-access-dev.dlp.cloud.lib.vt.edu",
              Type: "CNAME",
              TTL: 300,
              ResourceRecords: [
                {
                  Value:
                    "dlpnext-whunter-feature.us-east-1.elasticbeanstalk.com",
                },
              ],
            },
          },
        ],
      });
    });

    test("reuses the one client with the frontend's name, with its secret", async () => {
      const { run, io, secretStrings } = setup({
        clients: [
          { ClientId: "otherclient", ClientName: "dlpnext-whunter-other" },
          { ClientId: "existingclient", ClientName: "dlpnext-whunter-feature" },
        ],
      });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      expect(
        run.commands.filter(({ args }) => args[0] === "cognito-idp"),
      ).toEqual([
        {
          executable: "aws",
          args: [
            "cognito-idp",
            "list-user-pool-clients",
            "--user-pool-id",
            userPoolId,
          ],
        },
        {
          executable: "aws",
          args: [
            "cognito-idp",
            "describe-user-pool-client",
            "--user-pool-id",
            userPoolId,
            "--client-id",
            "existingclient",
          ],
        },
      ]);
      expect(secretStrings).toEqual(["existing-secret"]);
      expect(optionSettings(run.commands)).toContainEqual({
        Namespace: "aws:elasticbeanstalk:application:environment",
        OptionName: "COGNITO_CLIENT_ID",
        Value: "existingclient",
      });
    });

    test("refuses before changing anything when two clients have the frontend's name", async () => {
      const { run, io } = setup({
        clients: [
          { ClientId: "clientone", ClientName: "dlpnext-whunter-feature" },
          { ClientId: "clienttwo", ClientName: "dlpnext-whunter-feature" },
        ],
      });

      await expect(
        frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).rejects.toThrow(
        /2 Cognito clients .* named dlpnext-whunter-feature \(clientone, clienttwo\)/,
      );
      expect(writes(run.commands)).toEqual([]);
    });

    test("updates an existing secret, and reuses an existing version, e.g. after a failed first run", async () => {
      const { run, io, secretStrings } = setup({
        secretExists: true,
        versionExists: true,
      });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      const created = writes(run.commands).map(({ args }) =>
        args.slice(0, 2).join(" "),
      );
      expect(created).toContain("secretsmanager put-secret-value");
      expect(created).not.toContain("secretsmanager create-secret");
      expect(created).not.toContain("s3 cp");
      expect(created).not.toContain(
        "elasticbeanstalk create-application-version",
      );
      expect(secretStrings).toEqual(["new-secret"]);
    });

    test("bundles the commit with git archive", async () => {
      const { run, io } = setup();

      await frontendDeploy(["--backend-env", "dev"], undefined, io);

      const archive = run.commands.filter(
        ({ executable, args }) => executable === "git" && args[0] === "archive",
      );
      expect(archive).toEqual([
        {
          executable: "git",
          args: [
            "archive",
            "--format=zip",
            expect.stringMatching(/^--output=.*whunter-feature-0123456\.zip$/),
            commit,
          ],
        },
      ]);
    });

    test("--production picks the larger instance type", async () => {
      const { run, io } = setup();

      await frontendDeploy(
        ["--backend-env", "dev", "--production"],
        undefined,
        io,
      );

      expect(optionSettings(run.commands)).toContainEqual({
        Namespace: "aws:ec2:instances",
        OptionName: "InstanceTypes",
        Value: "t3.medium",
      });
    });

    test("never sets a setting that .ebextensions owns", async () => {
      const owned = committedOptions();
      const { run, io } = setup();

      await frontendDeploy(["--backend-env", "dev"], undefined, io);

      // Only eb init, which sets no option, runs through the EB CLI.
      expect(
        run.commands.filter(({ executable }) => executable === "eb"),
      ).toEqual([
        {
          executable: "eb",
          args: ["init", "dlpnext", "--platform", SOLUTION_STACK],
        },
      ]);
      expect(
        run.commands.filter(({ args }) =>
          /^(update-environment|update-configuration-template|create-configuration-template)$/.test(
            args[1] ?? "",
          ),
        ),
      ).toEqual([]);
      const settings = optionSettings(run.commands) as {
        Namespace: string;
        OptionName: string;
      }[];
      expect(settings.length).toBeGreaterThan(0);
      expect(
        settings.filter(
          ({ Namespace, OptionName }) =>
            owned[Namespace]?.[OptionName] !== undefined,
        ),
      ).toEqual([]);
    });

    test("keeps the client secret out of the plain-text environment properties and command lines", async () => {
      const { run, io } = setup();

      await frontendDeploy(["--backend-env", "dev"], undefined, io);

      expect(
        run.commands.filter(({ args }) =>
          args.some((arg) => arg.includes("new-secret")),
        ),
      ).toEqual([]);
      expect(
        (
          optionSettings(run.commands) as {
            Namespace: string;
            OptionName: string;
          }[]
        ).filter(({ OptionName }) => OptionName === "COGNITO_CLIENT_SECRET"),
      ).toEqual([
        {
          Namespace: "aws:elasticbeanstalk:application:environmentsecrets",
          OptionName: "COGNITO_CLIENT_SECRET",
          Value: secretArn,
        },
      ]);
    });

    test("keeps waiting while the environment is launching", async () => {
      const { run, io } = setup({ launchingWaits: 2 });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      expect(
        run.commands.filter(({ args }) => args[1] === "wait"),
      ).toHaveLength(3);
      expect(writes(run.commands).at(-1)!.args[1]).toBe(
        "change-resource-record-sets",
      );
    });

    test("waits for the new environment, not a terminated one with the same name", async () => {
      const { run, io } = setup({ previouslyTerminated: true });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);
      expect(writes(run.commands).at(-1)!.args[1]).toBe(
        "change-resource-record-sets",
      );
    });

    test("gives up, with no DNS record, when the environment never becomes ready", async () => {
      const { run, io } = setup({ launchingWaits: 99 });

      await expect(
        frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).rejects.toThrow(
        /dlpnext-whunter-feature did not become ready \(status Launching\)/,
      );
      expect(
        run.commands.filter(
          ({ args }) =>
            args[0] === "route53" && args[1] === "change-resource-record-sets",
        ),
      ).toEqual([]);
    });

    test("an existing environment is left alone", async () => {
      const { run, io } = setup({ appExists: true, environmentExists: true });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      expect(writes(run.commands)).toEqual(applicationSetup(run.commands));
    });
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
    // The fake only knows dev's parameters, which an existing frontend doesn't read.
    const { io, questions, output } = setup({
      appExists: true,
      environmentExists: true,
    });
    io.alert = (text) => `<red>${text}</red>`;

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
    expect(writes(run.commands)).not.toEqual([]);
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
