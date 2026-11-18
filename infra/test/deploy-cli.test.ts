import { optionsFromContext, planApp } from "../lib/app";
import {
  contextFromArgs,
  deployArgs,
  describePlan,
  isConfirmed,
  productionWarning,
  profileFromArgs,
} from "../lib/deployment/deploy-cli";

const awsAccountId = "123456789012";
const userPoolId = "us-east-1_AbCd12345";

describe("contextFromArgs", () => {
  test("reads -c, --context and --context= forms and ignores other flags", () => {
    expect(
      contextFromArgs([
        "-c",
        "backend-env=dev",
        "--context",
        "aws-account-id=123456789012",
        "--context=identity-provider=a=b",
        "--require-approval",
        "never",
      ]),
    ).toEqual({
      "backend-env": "dev",
      "aws-account-id": "123456789012",
      "identity-provider": "a=b",
    });
  });

  test.each([[["-c"]], [["-c", "backend-env"]], [["-c", "=dev"]]])(
    "rejects %p",
    (args) => {
      expect(() => contextFromArgs(args)).toThrow(/Invalid context argument/);
    },
  );
});

describe("profileFromArgs", () => {
  test.each([
    [["-c", "backend-env=dev"], undefined],
    [["--profile", "prod", "-c", "backend-env=production"], "prod"],
    [["--profile=prod"], "prod"],
  ])("reads %p", (args, profile) => {
    expect(profileFromArgs(args)).toBe(profile);
  });

  test("rejects --profile without a name", () => {
    expect(() => profileFromArgs(["--profile"])).toThrow(/profile name/);
  });
});

describe("deployArgs", () => {
  const context = [
    "-c",
    "backend-env=dev",
    "-c",
    `aws-account-id=${awsAccountId}`,
  ];

  test("without --yes, passes every argument through", () => {
    expect(
      deployArgs([...context, "--require-approval", "broadening"], undefined),
    ).toEqual({
      yes: false,
      check: true,
      cdkArgs: [...context, "--require-approval", "broadening"],
    });
  });

  test.each(["--yes", "-y"])(
    "%s in CI is removed and answers CDK approval too",
    (flag) => {
      expect(deployArgs([flag, ...context], "true")).toEqual({
        yes: true,
        check: true,
        cdkArgs: [...context, "--require-approval", "never"],
      });
    },
  );

  test.each([
    ["--require-approval", "broadening"],
    ["--require-approval=broadening"],
  ])("--yes keeps an explicit %s", (...approval) => {
    expect(deployArgs([...context, ...approval, "--yes"], "1").cdkArgs).toEqual(
      [...context, ...approval],
    );
  });

  test("--no-check is removed and turns off the check, in or out of CI", () => {
    expect(deployArgs(["--no-check", ...context], undefined)).toEqual({
      yes: false,
      check: false,
      cdkArgs: context,
    });
  });

  test.each([undefined, "", "false", "0"])(
    "rejects --yes when CI is %p",
    (ci) => {
      expect(() => deployArgs(["--yes", ...context], ci)).toThrow(
        /--yes only applies in CI/,
      );
    },
  );
});

describe("optionsFromContext", () => {
  test("parses the production flag and leaves missing keys undefined", () => {
    const context: Record<string, unknown> = {
      "backend-env": "dev",
      "aws-account-id": awsAccountId,
      production: "true",
    };
    expect(optionsFromContext((key) => context[key])).toEqual({
      backendEnv: "dev",
      awsAccountId,
      production: true,
    });
  });
});

describe("describePlan", () => {
  test("lists every option, with defaults applied, and the stacks", () => {
    const text = describePlan(
      planApp({ backendEnv: "f-search", awsAccountId, userPoolId }),
    );
    expect(text).toMatch(/Environment\s+f-search/);
    expect(text).toMatch(/Account\s+123456789012/);
    expect(text).toMatch(/Region\s+us-east-1/);
    expect(text).toMatch(
      /Production\s+false \(search: 1 x t3\.small\.search across 1 AZ\)$/m,
    );
    expect(text).toMatch(/User pool\s+us-east-1_AbCd12345/);
    expect(text).toMatch(/Identity provider\s+\(none: the pool's own users\)/);
    expect(text).toMatch(/Data on destroy\s+destroy/);
    expect(text).toMatch(
      /Stacks\s+DlpAccessNext-f-search-Data, DlpAccessNext-f-search-Api, DlpAccessNext-f-search-Auth$/m,
    );
    expect(text).not.toMatch(/Branch|Backend|App URL|Certificate/);
  });

  test("shows production sizing", () => {
    const text = describePlan(
      planApp({
        backendEnv: "production",
        awsAccountId,
        userPoolId,
        production: true,
      }),
    );
    expect(text).toMatch(
      /Production\s+true \(search: 3 x m7g\.medium\.search across 3 AZ\)$/m,
    );
    expect(text).toMatch(/Data on destroy\s+retain/);
  });

  test("shows the user pool and its identity provider", () => {
    const text = describePlan(
      planApp({
        backendEnv: "dev",
        awsAccountId,
        userPoolId,
        identityProvider: "VT-SSO-OIDC",
      }),
    );
    expect(text).toMatch(/User pool\s+us-east-1_AbCd12345/);
    expect(text).toMatch(
      /Identity provider\s+VT-SSO-OIDC \(must already be on the user pool/,
    );
  });
});

describe("productionWarning", () => {
  test("warns for the production environment, naming the account", () => {
    const warning = productionWarning(
      planApp({
        backendEnv: "production",
        awsAccountId,
        userPoolId,
        production: true,
      }),
    );
    expect(warning).toMatch(
      /WARNING: THIS DEPLOYS TO THE PRODUCTION ENVIRONMENT/,
    );
    expect(warning).toMatch(/Account 123456789012/);
    expect(warning).not.toMatch(/production=true is not set/);
  });

  test("also warns when production sizing is off", () => {
    expect(
      productionWarning(
        planApp({ backendEnv: "production", awsAccountId, userPoolId }),
      ),
    ).toMatch(/production=true is not set/);
  });

  test.each(["dev", "pre-production", "f-production"])(
    "says nothing for %p",
    (env) => {
      expect(
        productionWarning(
          planApp({
            backendEnv: env,
            awsAccountId,
            userPoolId,
            production: true,
          }),
        ),
      ).toBeUndefined();
    },
  );
});

describe("isConfirmed", () => {
  test.each(["y", "Y", "yes", "YES", "Yes", " yes \n"])(
    "accepts %p",
    (answer) => {
      expect(isConfirmed(answer)).toBe(true);
    },
  );

  test.each(["", "n", "no", "yep", "ye", "yes please", "sure"])(
    "rejects %p",
    (answer) => {
      expect(isConfirmed(answer)).toBe(false);
    },
  );
});
