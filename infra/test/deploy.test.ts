import { optionsFromContext, planApp } from '../lib/app';
import { contextFromArgs, deployArgs, describePlan, isConfirmed, productionWarning } from '../lib/deploy';

const account = '123456789012';
const userPool = 'us-east-1_AbCd12345';
const certificate = `arn:aws:acm:us-east-1:${account}:certificate/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7`;

describe('contextFromArgs', () => {
  test('reads -c, --context and --context= forms and ignores other flags', () => {
    expect(
      contextFromArgs([
        '-c', 'env=dev',
        '--context', 'account=123456789012',
        '--context=branch=whunter/a=b',
        '--require-approval', 'never',
      ]),
    ).toEqual({ env: 'dev', account: '123456789012', branch: 'whunter/a=b' });
  });

  test.each([[['-c']], [['-c', 'env']], [['-c', '=dev']]])('rejects %p', (args) => {
    expect(() => contextFromArgs(args)).toThrow(/Invalid context argument/);
  });
});

describe('deployArgs', () => {
  const context = ['-c', 'env=dev', '-c', `account=${account}`];

  test('without --yes, passes every argument through', () => {
    expect(deployArgs([...context, '--require-approval', 'broadening'], undefined)).toEqual({
      yes: false,
      cdkArgs: [...context, '--require-approval', 'broadening'],
    });
  });

  test.each(['--yes', '-y'])('%s in CI is removed and answers CDK approval too', (flag) => {
    expect(deployArgs([flag, ...context], 'true')).toEqual({
      yes: true,
      cdkArgs: [...context, '--require-approval', 'never'],
    });
  });

  test.each([['--require-approval', 'broadening'], ['--require-approval=broadening']])(
    '--yes keeps an explicit %s',
    (...approval) => {
      expect(deployArgs([...context, ...approval, '--yes'], '1').cdkArgs).toEqual([...context, ...approval]);
    },
  );

  test.each([undefined, '', 'false', '0'])('rejects --yes when CI is %p', (ci) => {
    expect(() => deployArgs(['--yes', ...context], ci)).toThrow(/--yes only applies in CI/);
  });
});

describe('optionsFromContext', () => {
  test('parses the production flag and leaves missing keys undefined', () => {
    const context: Record<string, unknown> = { env: 'dev', account, production: 'true' };
    expect(optionsFromContext((key) => context[key])).toEqual({
      env: 'dev',
      account,
      production: true,
      branch: undefined,
      backend: undefined,
      userPool: undefined,
      identityProvider: undefined,
      certificate: undefined,
    });
  });
});

describe('describePlan', () => {
  test('lists every option, with defaults applied, and the stacks', () => {
    const text = describePlan(
      planApp({ env: 'f-search', account, userPool, branch: 'whunter/Multi_Env', backend: 'provision', certificate }),
    );
    expect(text).toMatch(/Environment\s+f-search/);
    expect(text).toMatch(/Account\s+123456789012/);
    expect(text).toMatch(/Region\s+us-east-1/);
    expect(text).toMatch(/Production\s+false \(search: 1 x t3\.small\.search across 1 AZ; web: t3\.small\)/);
    expect(text).toMatch(/Branch\s+whunter-multi-env/);
    expect(text).toMatch(/Backend\s+provision/);
    expect(text).toMatch(/User pool\s+us-east-1_AbCd12345/);
    expect(text).toMatch(/Identity provider\s+\(none: the pool's own users\)/);
    expect(text).toMatch(/App URL\s+https:\/\/whunter-multi-env\.dlp-access-dev\.dlp\.cloud\.lib\.vt\.edu$/m);
    expect(text).toMatch(/Certificate\s+arn:aws:acm:us-east-1:123456789012:certificate\//);
    expect(text).toMatch(/Data on destroy\s+destroy/);
    expect(text).toMatch(
      /Stacks\s+DlpAccessNext-f-search-Data, DlpAccessNext-f-search-Api, DlpAccessNext-f-search-Auth, DlpAccessNext-Web-whunter-multi-env/,
    );
  });

  test('shows production sizing, and no branch or backend for an environment deploy', () => {
    const text = describePlan(planApp({ env: 'production', account, userPool, production: true }));
    expect(text).toMatch(/Production\s+true \(search: 3 x m7g\.medium\.search across 3 AZ; web: t3\.medium\)/);
    expect(text).toMatch(/Branch\s+\(none\)/);
    expect(text).toMatch(/Backend\s+\(none\)/);
    expect(text).toMatch(/App URL\s+\(none\)/);
    expect(text).toMatch(/Certificate\s+\(none\)/);
    expect(text).toMatch(/Data on destroy\s+retain/);
    expect(text).toMatch(
      /Stacks\s+DlpAccessNext-production-Data, DlpAccessNext-production-Api, DlpAccessNext-production-Auth$/m,
    );
  });

  test('attach deploys only the Web stack', () => {
    const text = describePlan(planApp({ env: 'dev', account, branch: 'main', certificate }));
    expect(text).toMatch(/Backend\s+attach/);
    expect(text).toMatch(/User pool\s+\(the environment's\)/);
    expect(text).toMatch(/Identity provider\s+\(the environment's\)/);
    expect(text).toMatch(/Stacks\s+DlpAccessNext-Web-main$/m);
  });

  test('shows the user pool and its identity provider', () => {
    const text = describePlan(
      planApp({
        env: 'dev',
        account,
        branch: 'main',
        backend: 'provision',
        userPool,
        identityProvider: 'VT-SSO-OIDC',
        certificate,
      }),
    );
    expect(text).toMatch(/User pool\s+us-east-1_AbCd12345/);
    expect(text).toMatch(/Identity provider\s+VT-SSO-OIDC \(must already be on the user pool/);
  });
});

describe('productionWarning', () => {
  test('warns for the production environment, naming the account', () => {
    const warning = productionWarning(planApp({ env: 'production', account, userPool, production: true }));
    expect(warning).toMatch(/WARNING: THIS DEPLOYS TO THE PRODUCTION ENVIRONMENT/);
    expect(warning).toMatch(/Account 123456789012/);
    expect(warning).not.toMatch(/production=true is not set/);
  });

  test('also warns when production sizing is off', () => {
    expect(productionWarning(planApp({ env: 'production', account, userPool }))).toMatch(/production=true is not set/);
  });

  test.each(['dev', 'pre-production', 'f-production'])('says nothing for %p', (env) => {
    expect(productionWarning(planApp({ env, account, userPool, production: true }))).toBeUndefined();
  });
});

describe('isConfirmed', () => {
  test.each(['y', 'Y', 'yes', 'YES', 'Yes', ' yes \n'])('accepts %p', (answer) => {
    expect(isConfirmed(answer)).toBe(true);
  });

  test.each(['', 'n', 'no', 'yep', 'ye', 'yes please', 'sure'])('rejects %p', (answer) => {
    expect(isConfirmed(answer)).toBe(false);
  });
});
