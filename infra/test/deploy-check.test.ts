import { planApp } from "../lib/app";
import { CommandError } from "../lib/command-runner";
import {
  checkDeploy,
  lookupDeployedState,
} from "../lib/deployment/deploy-check";
import { FakeRunner, fakeRunner } from "./fake-runner";

const awsAccountId = "123456789012";
const userPoolId = "us-east-1_AbCd12345";

const backend = planApp({
  backendEnv: "dev",
  awsAccountId,
  userPoolId,
  identityProvider: "VT-SSO-OIDC",
});

/** A failed `aws` command: the CLI exits 254 when the service returns an error. */
const awsError = (message: string) => new CommandError("aws", 254, message);

/**
 * A fake runner for the AWS CLI: `resources` maps "service command name" to
 * the parsed output, or to an Error to throw (a command without a name
 * argument is just "service command"). Anything missing is "not found".
 */
function fakeAws(
  resources: Record<string, unknown>,
  caller = awsAccountId,
): FakeRunner {
  return fakeRunner(({ executable, args }) => {
    if (executable !== "aws") {
      throw new Error(`unexpected ${executable} command`);
    }
    const [service, command] = args;
    if (service === "sts") {
      return JSON.stringify({ Account: caller });
    }
    const key =
      args.length > 2
        ? `${service} ${command} ${args[3]}`
        : `${service} ${command}`;
    const found = resources[key];
    if (found instanceof Error) {
      throw found;
    }
    if (found === undefined) {
      throw awsError(
        `An error occurred (ValidationError): ${args[3]} does not exist`,
      );
    }
    return JSON.stringify(found);
  });
}

const stack = (status: string, outputs: Record<string, string> = {}) => ({
  Stacks: [
    {
      StackStatus: status,
      Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({
        OutputKey,
        OutputValue,
      })),
    },
  ],
});
const domain = (instanceType: string, count: number) => ({
  DomainStatus: {
    ClusterConfig: { InstanceType: instanceType, InstanceCount: count },
  },
});
const deployedBackend = {
  "cloudformation describe-stacks DlpAccessNext-dev-Data":
    stack("UPDATE_COMPLETE"),
  "cloudformation describe-stacks DlpAccessNext-dev-Api":
    stack("UPDATE_COMPLETE"),
  "cloudformation describe-stacks DlpAccessNext-dev-Auth": stack(
    "CREATE_COMPLETE",
    {
      UserPoolId: userPoolId,
      IdentityProvider: "VT-SSO-OIDC",
    },
  ),
  "opensearch describe-domain dlpnext-dev": domain("t3.small.search", 1),
};

const check = (
  plan: typeof backend,
  resources: Record<string, unknown>,
  caller?: string,
) => checkDeploy(plan, lookupDeployedState(plan, fakeAws(resources, caller)));

describe("checkDeploy", () => {
  test("a new backend is created, with nothing to warn about", () => {
    expect(check(backend, {})).toEqual({
      stacks: [
        "DlpAccessNext-dev-Data: create",
        "DlpAccessNext-dev-Api: create",
        "DlpAccessNext-dev-Auth: create",
      ],
      warnings: [],
    });
  });

  test("a redeploy with the same settings is an update, with nothing to warn about", () => {
    const { stacks, warnings } = check(backend, deployedBackend);
    expect(stacks).toEqual([
      "DlpAccessNext-dev-Data: update (now UPDATE_COMPLETE)",
      "DlpAccessNext-dev-Api: update (now UPDATE_COMPLETE)",
      "DlpAccessNext-dev-Auth: update (now CREATE_COMPLETE)",
    ]);
    expect(warnings).toEqual([]);
  });

  test("warns about tables and a search domain left outside a Data stack being created", () => {
    const { stacks, warnings } = check(backend, {
      "cloudformation describe-stacks DlpAccessNext-dev-Data":
        stack("REVIEW_IN_PROGRESS"),
      "dynamodb list-tables": {
        TableNames: [
          "Archive-dlpnext-dev",
          "Archive-dlpnext-f-other",
          "Site-dlpnext-dev",
        ],
      },
      "opensearch describe-domain dlpnext-dev": domain("t3.small.search", 1),
    });
    expect(stacks[0]).toMatch(/Data: create \(an earlier create/);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Tables already exist outside .*: Archive-dlpnext-dev, Site-dlpnext-dev\./,
      ),
      expect.stringMatching(
        /^Search domain dlpnext-dev already exists outside/,
      ),
    ]);
  });

  test("warns when the user pool or identity provider changes", () => {
    const plan = planApp({
      backendEnv: "dev",
      awsAccountId,
      userPoolId: "us-east-1_Other1234",
    });
    expect(check(plan, deployedBackend).warnings).toEqual([
      `Repoints the dev environment's user pool from ${userPoolId} to us-east-1_Other1234.`,
      "Changes sign-in from VT-SSO-OIDC to COGNITO (was -c identity-provider left out?).",
      expect.stringMatching(
        /frontends pick up a sign-in change only when each is redeployed/,
      ),
    ]);
  });

  test("warns when production is redeployed without -c production=true", () => {
    const plan = planApp({
      backendEnv: "production",
      awsAccountId,
      userPoolId,
      identityProvider: "VT-SSO-OIDC",
    });
    const { warnings } = check(plan, {
      "cloudformation describe-stacks DlpAccessNext-production-Data":
        stack("UPDATE_COMPLETE"),
      "opensearch describe-domain dlpnext-production": domain(
        "m7g.medium.search",
        3,
      ),
    });
    expect(warnings).toEqual([
      "Changes search from 3 x m7g.medium.search to 1 x t3.small.search (smaller: was -c production=true left out?). Resizing a domain takes a while.",
    ]);
  });

  test("warns about a stack with an operation in progress", () => {
    const { stacks, warnings } = check(backend, {
      ...deployedBackend,
      "cloudformation describe-stacks DlpAccessNext-dev-Api":
        stack("UPDATE_IN_PROGRESS"),
    });
    expect(stacks).toContain(
      "DlpAccessNext-dev-Api: busy (now UPDATE_IN_PROGRESS)",
    );
    expect(warnings).toEqual([
      expect.stringMatching(/is UPDATE_IN_PROGRESS: the deploy will fail/),
    ]);
  });

  test("stops at credentials for another account", () => {
    expect(check(backend, deployedBackend, "210987654321")).toEqual({
      stacks: [],
      warnings: [
        expect.stringMatching(
          /credentials are for account 210987654321, not 123456789012/,
        ),
      ],
    });
  });

  test("reports lookups that fail for reasons other than not found", () => {
    const { stacks, warnings } = check(backend, {
      ...deployedBackend,
      "cloudformation describe-stacks DlpAccessNext-dev-Api": awsError(
        "AccessDenied: not authorized",
      ),
    });
    expect(stacks).toContain("DlpAccessNext-dev-Api: create");
    expect(warnings).toEqual([
      "Couldn't check stack DlpAccessNext-dev-Api: AccessDenied: not authorized",
    ]);
  });
});
