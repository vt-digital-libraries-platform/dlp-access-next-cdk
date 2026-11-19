import * as fs from "fs";
import * as path from "path";
import { Command, CommandError, RunnerOptions } from "../lib/command-runner";
import { resolveEnvironment } from "../lib/config/environments";
import {
  CALLBACK_PATH,
  FRONTEND_REGION,
  SOLUTION_STACK,
} from "../lib/config/web";
import { planFrontend } from "../lib/frontend/frontend";
import {
  FrontendIO,
  frontendDeploy,
  frontendDestroy,
  frontendStatus,
} from "../lib/frontend/frontend-cli";
import { committedOptions } from "./committed-options";
import { fakeRunner } from "./fake-runner";

const awsAccountId = "123456789012";

describe("planFrontend", () => {
  // The root app is a separate npm project, so its auth module is read as text.
  test("registers the app's sign-in callback route", () => {
    const repoRoot = path.join(__dirname, "..", "..");
    const auth = fs.readFileSync(
      path.join(repoRoot, "src", "lib", "auth.ts"),
      "utf8",
    );
    expect(auth.match(/export const CALLBACK_PATH = ["'](.*?)["']/)?.[1]).toBe(
      CALLBACK_PATH,
    );
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "src",
          "app",
          ...CALLBACK_PATH.split("/"),
          "route.ts",
        ),
      ),
    ).toBe(true);
  });

  test("every backend env is in the region frontend:status looks in", () => {
    for (const env of ["dev", "pre-production", "production", "f-feature"]) {
      expect(resolveEnvironment(env).region).toBe(FRONTEND_REGION);
    }
  });

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
  const environmentArn = `arn:aws:elasticbeanstalk:us-east-1:${awsAccountId}:environment/dlpnext/dlpnext-whunter-feature`;

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
    secretDeleting = false,
    versionExists = false,
    environmentExists = false,
    environmentStatus = "Ready",
    launchingWaits = 0,
    health = "Green",
    previouslyTerminated = false,
    tags = {
      "dlpnext:branch": "whunter/feature",
      "dlpnext:backend-env": "dev",
    } as Record<string, string>,
  } = {}) {
    let environment: Record<string, string> | undefined = environmentExists
      ? {
          Status: environmentStatus,
          Health: health,
          VersionLabel: "whunter-feature-fedcba9",
        }
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
      if (executable === "eb" && args[0] === "deploy") {
        environment = {
          ...environment!,
          VersionLabel: flagValue(
            args,
            args.includes("--version") ? "--version" : "--label",
          ),
        };
        return "";
      }
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
              : secretDeleting && args.includes("--include-planned-deletion")
                ? [
                    {
                      ARN: secretArn,
                      Name: "dlpnext/whunter-feature/cognito-client-secret",
                      DeletedDate: "2026-11-17T12:00:00Z",
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
                    EnvironmentArn: environmentArn,
                    CNAME:
                      "dlpnext-whunter-feature.us-east-1.elasticbeanstalk.com",
                    ...environment,
                  },
                ]
              : [],
          });
        case "elasticbeanstalk list-tags-for-resource":
          expect(flagValue(args, "--resource-arn")).toBe(environmentArn);
          return json({
            ResourceArn: environmentArn,
            ResourceTags: Object.entries(tags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
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

    test("refuses before changing anything while the secret is scheduled for deletion, e.g. just after a destroy", async () => {
      const { run, io } = setup({ secretDeleting: true });

      await expect(
        frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).rejects.toThrow(
        /dlpnext\/whunter-feature\/cognito-client-secret is scheduled for deletion/,
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
  });

  describe("a later deploy", () => {
    test("checks the tags, upserts the DNS record, then runs eb deploy of HEAD with the version label", async () => {
      // No lifecycle policy: a redeploy still leaves the application alone.
      const { run, io, output } = setup({
        appExists: true,
        hasPolicy: false,
        environmentExists: true,
      });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      expect(
        run.commands.filter(({ args }) => args[1] === "list-tags-for-resource"),
      ).toEqual([
        {
          executable: "aws",
          args: [
            "elasticbeanstalk",
            "list-tags-for-resource",
            "--resource-arn",
            environmentArn,
          ],
        },
      ]);
      expect(writes(run.commands)).toEqual([
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
        {
          executable: "eb",
          args: ["init", "dlpnext", "--platform", SOLUTION_STACK],
        },
        {
          executable: "eb",
          args: [
            "deploy",
            "dlpnext-whunter-feature",
            "--label",
            "whunter-feature-0123456",
          ],
        },
      ]);
      expect(output.join("\n")).toMatch(
        /dlpnext-whunter-feature is running whunter-feature-0123456/,
      );
    });

    test.each(["Launching", "Updating"])(
      "waits for an environment that is %s, e.g. after a first deploy cut short, then writes its DNS record and deploys",
      async (environmentStatus) => {
        const { run, io } = setup({
          appExists: true,
          environmentExists: true,
          environmentStatus,
        });

        expect(
          await frontendDeploy(["--backend-env", "dev"], undefined, io),
        ).toBe(0);

        const steps = run.commands
          .map(({ executable, args }) =>
            executable === "eb" ? `eb ${args[0]}` : `${args[0]} ${args[1]}`,
          )
          .filter((step) =>
            /^(eb deploy|elasticbeanstalk wait|route53 change-resource-record-sets)$/.test(
              step,
            ),
          );
        expect(steps).toEqual([
          "elasticbeanstalk wait",
          "route53 change-resource-record-sets",
          "eb deploy",
        ]);
        const wait = run.commands.find(({ args }) => args[1] === "wait")!;
        expect(wait.args[2]).toBe(
          environmentStatus === "Launching"
            ? "environment-exists"
            : "environment-updated",
        );
        const record = run.commands.find(
          ({ args }) => args[1] === "change-resource-record-sets",
        )!;
        expect(JSON.parse(record.args[5]).Changes[0].ResourceRecordSet).toEqual(
          {
            Name: "whunter-feature.dlp-access-dev.dlp.cloud.lib.vt.edu",
            Type: "CNAME",
            TTL: 300,
            ResourceRecords: [
              {
                Value: "dlpnext-whunter-feature.us-east-1.elasticbeanstalk.com",
              },
            ],
          },
        );
      },
    );

    test("refuses, changing nothing, an environment that is terminating", async () => {
      const { run, io } = setup({
        appExists: true,
        environmentExists: true,
        environmentStatus: "Terminating",
      });

      await expect(
        frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).rejects.toThrow(
        /dlpnext-whunter-feature is Terminating, so it can't take a deploy/,
      );
      expect(writes(run.commands)).toEqual([]);
    });

    test("redeploying a commit already deployed deploys its existing version", async () => {
      const { run, io } = setup({
        appExists: true,
        environmentExists: true,
        versionExists: true,
      });

      expect(
        await frontendDeploy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);

      expect(writes(run.commands)).toEqual([
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
        {
          executable: "eb",
          args: ["init", "dlpnext", "--platform", SOLUTION_STACK],
        },
        {
          executable: "eb",
          args: [
            "deploy",
            "dlpnext-whunter-feature",
            "--version",
            "whunter-feature-0123456",
          ],
        },
      ]);
    });

    test.each([
      [
        "a branch whose name shares the slug",
        { "dlpnext:branch": "whunter-feature", "dlpnext:backend-env": "dev" },
        /dlpnext-whunter-feature is the frontend for branch "whunter-feature", not "whunter\/feature".*Destroy the frontend and deploy again to recreate it/s,
      ],
      [
        "another backend",
        {
          "dlpnext:branch": "whunter/feature",
          "dlpnext:backend-env": "f-search",
        },
        /dlpnext-whunter-feature uses backend env "f-search", not "dev".*Destroy the frontend and deploy again to recreate it/s,
      ],
      [
        "nothing, without the tags",
        {},
        /dlpnext-whunter-feature has no dlpnext:branch or dlpnext:backend-env tag.*Destroy the frontend and deploy again to recreate it/s,
      ],
    ])(
      "refuses, changing nothing, an environment tagged for %s",
      async (_, tags, error) => {
        const { run, io } = setup({
          appExists: true,
          environmentExists: true,
          tags,
        });

        await expect(
          frontendDeploy(["--backend-env", "dev"], undefined, io),
        ).rejects.toThrow(error);

        expect(writes(run.commands)).toEqual([]);
      },
    );
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
      tags: {
        "dlpnext:branch": "whunter/feature",
        "dlpnext:backend-env": "production",
      },
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

describe("frontendDestroy", () => {
  const userPoolId = "us-east-1_AbCdEfGhI";
  const environmentArn = `arn:aws:elasticbeanstalk:us-east-1:${awsAccountId}:environment/dlpnext/dlpnext-whunter-feature`;
  const endpoint = "dlpnext-whunter-feature.us-east-1.elasticbeanstalk.com";
  const domainName = "whunter-feature.dlp-access-dev.dlp.cloud.lib.vt.edu";
  const secretName = "dlpnext/whunter-feature/cognito-client-secret";
  const record = {
    Name: `${domainName}.`,
    Type: "CNAME",
    TTL: 300,
    ResourceRecords: [{ Value: endpoint }],
  };
  const frontendClient = {
    ClientId: "frontendclient",
    ClientName: "dlpnext-whunter-feature",
  };
  const otherClient = {
    ClientId: "otherclient",
    ClientName: "dlpnext-whunter-other",
  };

  const flagValue = (args: readonly string[], name: string) =>
    args[args.indexOf(name) + 1];

  /**
   * Fakes a frontend's AWS state, removing pieces as commands delete them.
   * `failOnce` names an `aws <service> <operation>` that fails the first
   * time it runs, as if the connection dropped.
   */
  function setup({
    answer = "yes",
    environment = "Ready" as string | undefined,
    tags = {
      "dlpnext:branch": "whunter/feature",
      "dlpnext:backend-env": "dev",
    } as Record<string, string>,
    terminatingWaits = 0,
    recordExists = true,
    clients = [otherClient, frontendClient],
    secretExists = true,
    failOnce = undefined as string | undefined,
    userPoolIdParameter = true,
  } = {}) {
    const state = {
      environment,
      recordExists,
      clients: [...clients],
      secretExists,
    };
    let waitsLeft = terminatingWaits;
    let failure = failOnce;
    const json = (value: unknown) => JSON.stringify(value);
    const run = fakeRunner(({ executable, args }) => {
      const command = [executable, ...args].join(" ");
      if (command === "git branch --show-current") return "whunter/feature\n";
      if (executable !== "aws") {
        throw new Error(`unexpected command: ${command}`);
      }
      const operation = `${args[0]} ${args[1]}`;
      if (operation === failure) {
        failure = undefined;
        throw new CommandError("aws", 255, "Connection was closed");
      }
      switch (operation) {
        case "sts get-caller-identity":
          return json({ Account: awsAccountId });
        case "ssm get-parameter":
          expect(flagValue(args, "--name")).toBe(
            "/dlp-access-next/dev/user-pool-id",
          );
          if (!userPoolIdParameter) {
            throw new CommandError("aws", 254, "ParameterNotFound");
          }
          return json({ Parameter: { Value: userPoolId } });
        case "elasticbeanstalk describe-environments":
          expect(args).toContain("--no-include-deleted");
          return json({
            Environments: state.environment
              ? [
                  {
                    EnvironmentName: "dlpnext-whunter-feature",
                    EnvironmentArn: environmentArn,
                    CNAME: endpoint,
                    Status: state.environment,
                    Health: "Green",
                  },
                ]
              : [],
          });
        case "elasticbeanstalk list-tags-for-resource":
          return json({
            ResourceArn: environmentArn,
            ResourceTags: Object.entries(tags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          });
        case "elasticbeanstalk terminate-environment":
          if (state.environment !== "Ready") {
            throw new CommandError("aws", 254, "InvalidParameterValue");
          }
          state.environment = "Terminating";
          return "{}";
        case "elasticbeanstalk wait":
          if (args[2] !== "environment-terminated") {
            // A launch or update in progress finishes.
            state.environment = "Ready";
            return "";
          }
          if (waitsLeft > 0) {
            waitsLeft--;
            throw new CommandError(
              "aws",
              255,
              "Waiter EnvironmentTerminated failed: Max attempts exceeded",
            );
          }
          state.environment = undefined;
          return "";
        case "route53 list-hosted-zones-by-name":
          return json({
            HostedZones: [
              {
                Id: "/hostedzone/Z0123456789",
                Name: "dlp.cloud.lib.vt.edu.",
                Config: { PrivateZone: false },
              },
            ],
          });
        case "route53 list-resource-record-sets":
          // Records are listed from the start name on, so once the CNAME is
          // gone the next record, someone else's, comes back.
          return json({
            ResourceRecordSets: [
              ...(state.recordExists ? [record] : []),
              {
                Name: "x-other.dlp-access-dev.dlp.cloud.lib.vt.edu.",
                Type: "CNAME",
                TTL: 300,
                ResourceRecords: [{ Value: "elsewhere.example.com" }],
              },
            ],
          });
        case "route53 change-resource-record-sets":
          if (!state.recordExists) {
            throw new CommandError("aws", 254, "InvalidChangeBatch");
          }
          state.recordExists = false;
          return "{}";
        case "cognito-idp list-user-pool-clients":
          expect(flagValue(args, "--user-pool-id")).toBe(userPoolId);
          return json({ UserPoolClients: state.clients });
        case "cognito-idp delete-user-pool-client": {
          const id = flagValue(args, "--client-id");
          if (!state.clients.some(({ ClientId }) => ClientId === id)) {
            throw new CommandError("aws", 254, "ResourceNotFoundException");
          }
          state.clients = state.clients.filter(
            ({ ClientId }) => ClientId !== id,
          );
          return "";
        }
        case "secretsmanager list-secrets":
          return json({
            SecretList: [
              // A prefix match, which the name filter also returns.
              { Name: `${secretName}-old` },
              ...(state.secretExists ? [{ Name: secretName }] : []),
            ],
          });
        case "secretsmanager delete-secret":
          if (!state.secretExists) {
            throw new CommandError("aws", 254, "ResourceNotFoundException");
          }
          state.secretExists = false;
          return "{}";
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const questions: string[] = [];
    const output: string[] = [];
    const io: { -readonly [K in keyof FrontendIO]: FrontendIO[K] } = {
      alert: (text) => text,
      runner: () => run,
      ask: async (question) => {
        questions.push(question);
        return answer;
      },
      log: (text) => output.push(text),
    };
    return { run, io, state, questions, output };
  }

  /** The commands that change something in AWS, and the waits between them. */
  const teardown = (commands: Command[]) =>
    commands.filter(({ args }) =>
      /^(wait|terminate-.*|delete-.*|change-.*)$/.test(args[1] ?? ""),
    );

  const gone = {
    environment: undefined,
    recordExists: false,
    clients: [otherClient],
    secretExists: false,
  };

  test("removes a complete frontend: environment, CNAME, Cognito client, then secret", async () => {
    const { run, io, state } = setup();

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );

    expect(teardown(run.commands)).toEqual([
      {
        executable: "aws",
        args: [
          "elasticbeanstalk",
          "terminate-environment",
          "--environment-name",
          "dlpnext-whunter-feature",
        ],
      },
      {
        executable: "aws",
        args: [
          "elasticbeanstalk",
          "wait",
          "environment-terminated",
          "--application-name",
          "dlpnext",
          "--environment-names",
          "dlpnext-whunter-feature",
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
      {
        executable: "aws",
        args: [
          "cognito-idp",
          "delete-user-pool-client",
          "--user-pool-id",
          userPoolId,
          "--client-id",
          "frontendclient",
        ],
      },
      {
        executable: "aws",
        args: [
          "secretsmanager",
          "delete-secret",
          "--secret-id",
          secretName,
          "--force-delete-without-recovery",
        ],
      },
    ]);
    expect(
      JSON.parse(flagValue(teardown(run.commands)[2].args, "--change-batch")),
    ).toEqual({ Changes: [{ Action: "DELETE", ResourceRecordSet: record }] });
    expect(state).toEqual(gone);
  });

  test.each([
    "elasticbeanstalk terminate-environment",
    "route53 list-resource-record-sets",
    "route53 change-resource-record-sets",
    "cognito-idp list-user-pool-clients",
    "cognito-idp delete-user-pool-client",
    "secretsmanager list-secrets",
    "secretsmanager delete-secret",
  ])("a re-run after %s fails finishes the teardown", async (failOnce) => {
    const { io, state } = setup({ failOnce });

    await expect(
      frontendDestroy(["--backend-env", "dev"], undefined, io),
    ).rejects.toThrow(/Connection was closed/);
    expect(state).not.toEqual(gone);

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );
    expect(state).toEqual(gone);
  });

  test.each([
    [
      "nothing left",
      {
        environment: undefined,
        recordExists: false,
        clients: [otherClient],
        secretExists: false,
      },
    ],
    [
      "only a client and secret, from a deploy that failed before the environment",
      { environment: undefined, recordExists: false },
    ],
    ["no CNAME, from a deploy that gave up waiting", { recordExists: false }],
    [
      "only the secret",
      { environment: undefined, recordExists: false, clients: [otherClient] },
    ],
    [
      "only the environment",
      { recordExists: false, clients: [otherClient], secretExists: false },
    ],
  ])("skips what is missing from a frontend with %s", async (_, pieces) => {
    const { io, state, output } = setup(pieces);

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );
    expect(state).toEqual(gone);
    expect(output.join("\n")).toMatch(/already gone/);
  });

  test("deletes every client with the frontend's name", async () => {
    const duplicate = { ...frontendClient, ClientId: "duplicateclient" };
    const { io, state } = setup({
      clients: [frontendClient, otherClient, duplicate],
    });

    await frontendDestroy(["--backend-env", "dev"], undefined, io);

    expect(state.clients).toEqual([otherClient]);
  });

  test("a re-run while the environment is terminating waits for it, then finishes", async () => {
    const { run, io, state } = setup({ environment: "Terminating" });

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );
    expect(
      run.commands.filter(({ args }) => args[1] === "terminate-environment"),
    ).toEqual([]);
    expect(state).toEqual(gone);
  });

  test("keeps waiting while the environment is terminating", async () => {
    const { run, io, state } = setup({ terminatingWaits: 2 });

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );
    expect(run.commands.filter(({ args }) => args[1] === "wait")).toHaveLength(
      3,
    );
    expect(state).toEqual(gone);
  });

  test("gives up, deleting nothing else, when the environment never terminates", async () => {
    const { run, io, state } = setup({ terminatingWaits: 99 });

    await expect(
      frontendDestroy(["--backend-env", "dev"], undefined, io),
    ).rejects.toThrow(
      /dlpnext-whunter-feature did not terminate \(status Terminating\)/,
    );
    expect(teardown(run.commands).map(({ args }) => args[1])).toEqual([
      "terminate-environment",
      "wait",
      "wait",
      "wait",
      "wait",
    ]);
    expect(state.secretExists).toBe(true);
  });

  test("a re-run after giving up on the wait finishes the teardown", async () => {
    const { io, state } = setup({ terminatingWaits: 4 });

    await expect(
      frontendDestroy(["--backend-env", "dev"], undefined, io),
    ).rejects.toThrow(/did not terminate/);
    expect(state.environment).toBe("Terminating");

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );
    expect(state).toEqual(gone);
  });

  test.each([
    ["Launching", "environment-exists"],
    ["Updating", "environment-updated"],
  ])(
    "waits for an environment that is %s to settle, then terminates it",
    async (environment, waiter) => {
      const { run, io, state } = setup({ environment });

      expect(
        await frontendDestroy(["--backend-env", "dev"], undefined, io),
      ).toBe(0);
      expect(
        teardown(run.commands)
          .slice(0, 3)
          .map(({ args }) => (args[1] === "wait" ? args[2] : args[1])),
      ).toEqual([waiter, "terminate-environment", "environment-terminated"]);
      expect(state).toEqual(gone);
    },
  );

  test("removes the environment and CNAME even when the backend's user pool parameter is gone", async () => {
    const { io, state } = setup({ userPoolIdParameter: false });

    await expect(
      frontendDestroy(["--backend-env", "dev"], undefined, io),
    ).rejects.toThrow(/ParameterNotFound/);
    expect(state.environment).toBeUndefined();
    expect(state.recordExists).toBe(false);
  });

  test("refuses, changing nothing, an environment tagged for another backend", async () => {
    const { run, io, state } = setup({
      tags: {
        "dlpnext:branch": "whunter/feature",
        "dlpnext:backend-env": "f-search",
      },
    });

    await expect(
      frontendDestroy(["--backend-env", "dev"], undefined, io),
    ).rejects.toThrow(
      /dlpnext-whunter-feature uses backend env "f-search", not "dev".*--backend-env f-search/s,
    );
    expect(teardown(run.commands)).toEqual([]);
    expect(state.environment).toBe("Ready");
  });

  test("destroys an environment tagged for a branch that shares the slug, as deploy's refusal says to", async () => {
    const { io, state } = setup({
      tags: {
        "dlpnext:branch": "whunter-feature",
        "dlpnext:backend-env": "dev",
      },
    });

    expect(await frontendDestroy(["--backend-env", "dev"], undefined, io)).toBe(
      0,
    );
    expect(state).toEqual(gone);
  });

  test.each(["", "no", "n", "yess"])(
    "answering %p changes nothing",
    async (answer) => {
      const { run, io, questions, output } = setup({ answer });

      expect(
        await frontendDestroy(["--backend-env", "dev"], undefined, io),
      ).toBe(1);

      expect(questions).toEqual(['Destroy? Type "yes" or "y" to continue: ']);
      expect(teardown(run.commands)).toEqual([]);
      expect(output).toContain("Not destroyed.");
    },
  );

  test("prints what it is about to destroy before asking", async () => {
    const { io, output } = setup({ answer: "no" });

    await frontendDestroy(
      ["--backend-env", "dev", "--branch", "whunter/feature"],
      undefined,
      io,
    );

    const printed = output.join("\n");
    expect(printed).toMatch(/dlpnext-whunter-feature/);
    expect(printed).toMatch(/whunter-feature\.dlp-access-dev/);
    expect(printed).toMatch(/dlpnext\/whunter-feature\/cognito-client-secret/);
  });

  test("the production backend gets a highlighted question", async () => {
    const { io, questions } = setup({ answer: "no" });
    io.alert = (text) => `<red>${text}</red>`;

    await frontendDestroy(["--backend-env", "production"], undefined, io);

    expect(questions).toEqual([
      '<red>Destroy this frontend of the PRODUCTION backend? Type "yes" or "y" to continue: </red>',
    ]);
  });

  test("--yes in CI skips the prompt", async () => {
    const { io, questions, state } = setup({ answer: "no" });

    expect(
      await frontendDestroy(["--backend-env", "dev", "--yes"], "true", io),
    ).toBe(0);
    expect(questions).toEqual([]);
    expect(state).toEqual(gone);
  });

  test.each([
    [["--backend-env", "dev", "-y"], /only applies in CI/],
    [[], /Missing backend env: pass --backend-env <env>/],
    [["--backend-env", "dev", "--production"], /Unknown option '--production'/],
  ])(
    "rejects the arguments %p before any command runs",
    async (argv, error) => {
      const { run, io } = setup();

      await expect(frontendDestroy(argv, undefined, io)).rejects.toThrow(error);
      expect(run.commands).toEqual([]);
    },
  );
});

describe("frontendStatus", () => {
  const userPoolId = "us-east-1_AbCdEfGhI";
  const environmentArn = `arn:aws:elasticbeanstalk:us-east-1:${awsAccountId}:environment/dlpnext/dlpnext-whunter-feature`;
  const endpoint = "dlpnext-whunter-feature.us-east-1.elasticbeanstalk.com";
  const secretName = "dlpnext/whunter-feature/cognito-client-secret";
  const secretValue = "s3cr3t-client-secret-value";
  const issuer = `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`;

  /** Fakes a deployed frontend; secret values are there to be read, and must never be. */
  function setup({
    environment = true,
    tags = {
      "dlpnext:branch": "whunter/feature",
      "dlpnext:backend-env": "pre-production",
    } as Record<string, string>,
    environmentStatus = "Ready",
  } = {}) {
    const json = (value: unknown) => JSON.stringify(value);
    const run = fakeRunner(({ executable, args }) => {
      const command = [executable, ...args].join(" ");
      if (command === "git branch --show-current") return "whunter/feature\n";
      if (executable !== "aws") {
        throw new Error(`unexpected command: ${command}`);
      }
      switch (`${args[0]} ${args[1]}`) {
        case "elasticbeanstalk describe-environments":
          expect(args).toContain("--no-include-deleted");
          return json({
            Environments: environment
              ? [
                  {
                    EnvironmentName: "dlpnext-whunter-feature",
                    EnvironmentArn: environmentArn,
                    CNAME: endpoint,
                    Status: environmentStatus,
                    Health: "Green",
                    VersionLabel: "whunter-feature-0123abc",
                  },
                ]
              : [],
          });
        case "elasticbeanstalk list-tags-for-resource":
          return json({
            ResourceTags: Object.entries(tags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          });
        case "elasticbeanstalk describe-configuration-settings": {
          const setting = (
            Namespace: string,
            OptionName: string,
            Value: string,
          ) => ({ Namespace, OptionName, Value });
          const env = "aws:elasticbeanstalk:application:environment";
          return json({
            ConfigurationSettings: [
              {
                OptionSettings: [
                  setting("aws:ec2:instances", "InstanceTypes", "t3.small"),
                  setting(env, "COGNITO_ISSUER", issuer),
                  setting(env, "COGNITO_CLIENT_ID", "frontendclient"),
                  setting(env, "COGNITO_IDENTITY_PROVIDER", "VTGateway"),
                  setting(
                    "aws:elasticbeanstalk:application:environmentsecrets",
                    "COGNITO_CLIENT_SECRET",
                    `arn:aws:secretsmanager:us-east-1:${awsAccountId}:secret:${secretName}-AbCdEf`,
                  ),
                ],
              },
            ],
          });
        }
        case "secretsmanager get-secret-value":
          return json({ SecretString: secretValue });
        case "cognito-idp describe-user-pool-client":
          return json({
            UserPoolClient: {
              ClientId: "frontendclient",
              ClientSecret: secretValue,
            },
          });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const output: string[] = [];
    const runnerOptions: RunnerOptions[] = [];
    const io: FrontendIO = {
      alert: (text) => text,
      runner: (options) => {
        runnerOptions.push(options);
        return run;
      },
      ask: async () => {
        throw new Error("status never asks");
      },
      log: (text) => output.push(text),
    };
    return { run, io, output, runnerOptions };
  }

  test("prints how to reach the frontend and run the branch locally", async () => {
    const { io, output, run } = setup();

    expect(await frontendStatus([], io)).toBe(0);

    const text = output.join("\n");
    for (const value of [
      "whunter/feature",
      "https://whunter-feature.dlp-access-dev.dlp.cloud.lib.vt.edu",
      endpoint,
      "pre-production",
      issuer,
      "frontendclient",
      "VTGateway",
      secretName,
    ]) {
      expect(text).toContain(value);
    }
    // Read-only: nothing is changed.
    expect(
      run.commands.filter(({ args }) =>
        /^(create|update|delete|put|terminate)-/.test(args[1] ?? ""),
      ),
    ).toEqual([]);
  });

  test("never prints the client secret's value, nor reads it", async () => {
    const { io, output, run } = setup();

    await frontendStatus([], io);

    expect(output.join("\n")).not.toContain(secretValue);
    expect(run.commands.map(({ args }) => `${args[0]} ${args[1]}`)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/get-secret-value|describe-user-pool-client/),
      ]),
    );
  });

  test("a branch with no frontend says it isn't deployed", async () => {
    const { io, output } = setup({ environment: false });

    expect(await frontendStatus(["--branch", "someone/else"], io)).toBe(1);

    const text = output.join("\n");
    expect(text).toContain("not deployed");
    expect(text).toContain("someone/else");
  });

  test("a frontend being destroyed counts as not deployed, without reading its settings", async () => {
    const { io, output, run } = setup({ environmentStatus: "Terminating" });

    expect(await frontendStatus([], io)).toBe(1);

    expect(output.join("\n")).toContain("not deployed");
    expect(run.commands.map(({ args }) => args[1])).not.toContain(
      "describe-configuration-settings",
    );
  });

  test("--branch and --profile pick the frontend and the credentials", async () => {
    const { io, run, runnerOptions } = setup();

    await frontendStatus(
      ["--branch", "whunter/feature", "--profile", "dlp"],
      io,
    );

    expect(runnerOptions).toEqual([{ region: "us-east-1", profile: "dlp" }]);
    expect(run.commands).not.toContainEqual({
      executable: "git",
      args: ["branch", "--show-current"],
    });
    expect(
      run.commands.find(({ args }) => args[1] === "describe-environments")
        ?.args,
    ).toContain("dlpnext-whunter-feature");
  });

  test("an environment tagged for another branch that shares the slug shows that branch", async () => {
    const { io, output } = setup({
      tags: {
        "dlpnext:branch": "whunter_feature",
        "dlpnext:backend-env": "dev",
      },
    });

    await frontendStatus([], io);

    expect(output.join("\n")).toContain("whunter_feature");
  });
});
