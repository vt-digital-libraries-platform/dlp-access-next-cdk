import { optionsFromContext, planApp } from '../lib/app';
import { contextFromArgs, describePlan, isConfirmed } from '../lib/deploy';

const account = '123456789012';

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

describe('optionsFromContext', () => {
  test('parses the production flag and leaves missing keys undefined', () => {
    const context: Record<string, unknown> = { env: 'dev', account, production: 'true' };
    expect(optionsFromContext((key) => context[key])).toEqual({
      env: 'dev',
      account,
      production: true,
      branch: undefined,
      backend: undefined,
    });
  });
});

describe('describePlan', () => {
  test('lists every option, with defaults applied, and the stacks', () => {
    const text = describePlan(planApp({ env: 'f-search', account, branch: 'whunter/Multi_Env', backend: 'provision' }));
    expect(text).toMatch(/Environment\s+f-search/);
    expect(text).toMatch(/Account\s+123456789012/);
    expect(text).toMatch(/Region\s+us-east-1/);
    expect(text).toMatch(/Production\s+false \(search: 1 x t3\.small\.search across 1 AZ; web: t3\.small\)/);
    expect(text).toMatch(/Branch\s+whunter-multi-env/);
    expect(text).toMatch(/Backend\s+provision/);
    expect(text).toMatch(/Data on destroy\s+destroy/);
    expect(text).toMatch(
      /Stacks\s+DlpAccessNext-f-search-Data, DlpAccessNext-f-search-Api, DlpAccessNext-Web-whunter-multi-env/,
    );
  });

  test('shows production sizing, and no branch or backend for an environment deploy', () => {
    const text = describePlan(planApp({ env: 'production', account, production: true }));
    expect(text).toMatch(/Production\s+true \(search: 3 x m7g\.medium\.search across 3 AZ; web: t3\.medium\)/);
    expect(text).toMatch(/Branch\s+\(none\)/);
    expect(text).toMatch(/Backend\s+\(none\)/);
    expect(text).toMatch(/Data on destroy\s+retain/);
    expect(text).toMatch(/Stacks\s+DlpAccessNext-production-Data, DlpAccessNext-production-Api$/m);
  });

  test('attach deploys only the Web stack', () => {
    const text = describePlan(planApp({ env: 'dev', account, branch: 'main' }));
    expect(text).toMatch(/Backend\s+attach/);
    expect(text).toMatch(/Stacks\s+DlpAccessNext-Web-main$/m);
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
