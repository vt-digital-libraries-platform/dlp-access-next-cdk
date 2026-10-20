import { AppPlan } from './app';

/**
 * Collects the `-c key=value` and `--context key=value` (or
 * `--context=key=value`) arguments of a `cdk` command line.
 */
export function contextFromArgs(args: readonly string[]): Record<string, string> {
  const context: Record<string, string> = {};
  const add = (pair: string | undefined) => {
    const eq = pair?.indexOf('=') ?? -1;
    if (pair === undefined || eq < 1) {
      throw new Error(`Invalid context argument "${pair ?? ''}": use -c key=value`);
    }
    context[pair.slice(0, eq)] = pair.slice(eq + 1);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '--context') {
      add(args[++i]);
    } else if (arg.startsWith('--context=')) {
      add(arg.slice('--context='.length));
    }
  }
  return context;
}

const YES_FLAGS = ['--yes', '-y'];
const NO_CHECK_FLAG = '--no-check';

/**
 * Splits the deploy script's own flags from the arguments it passes to
 * `cdk deploy`. `--yes` (or `-y`) skips the confirmation, so it is accepted
 * only in CI (the `CI` environment variable is `true` or `1`), where approval
 * belongs to the pipeline. It also answers CDK's own approval prompt for
 * security-sensitive changes, unless `--require-approval` is given.
 * `--no-check` skips looking up what is already deployed.
 */
export function deployArgs(
  args: readonly string[],
  ci: string | undefined,
): { yes: boolean; check: boolean; cdkArgs: string[] } {
  const yes = args.some((arg) => YES_FLAGS.includes(arg));
  const check = !args.includes(NO_CHECK_FLAG);
  const rest = args.filter((arg) => !YES_FLAGS.includes(arg) && arg !== NO_CHECK_FLAG);
  if (!yes) {
    return { yes, check, cdkArgs: rest };
  }
  if (!/^(true|1)$/i.test(ci ?? '')) {
    throw new Error('--yes only applies in CI (CI=true); run without it to confirm the deploy');
  }
  const approval = rest.some((arg) => arg === '--require-approval' || arg.startsWith('--require-approval='));
  return { yes, check, cdkArgs: approval ? rest : [...rest, '--require-approval', 'never'] };
}

/** The confirmation text shown before deploying. */
export function describePlan(plan: AppPlan): string {
  const { config } = plan;
  const search = config.search;
  const stacks = [plan.dataStackName, plan.apiStackName, plan.authStackName, plan.webStackName].filter(Boolean);
  // Without an Auth stack, the Web stack uses whichever pool and provider the environment already has.
  const attached = "(the environment's)";
  const userPool = plan.userPool ?? attached;
  const identityProvider = !plan.authStackName
    ? attached
    : plan.identityProvider
      ? `${plan.identityProvider} (must already be on the user pool before a Web stack deploys)`
      : "(none: the pool's own users)";
  const rows: [string, string][] = [
    ['Environment', config.name],
    ['Account', plan.account],
    ['Region', config.region],
    [
      'Production',
      `${plan.production} (search: ${search.dataNodes} x ${search.instanceType} across ${search.availabilityZones} AZ; web: ${config.web.instanceType})`,
    ],
    ['Branch', plan.branch ?? '(none)'],
    ['Backend', plan.backend ?? '(none)'],
    ['User pool', userPool],
    ['Identity provider', identityProvider],
    ['App URL', plan.appUrl ?? '(none)'],
    ['Certificate', plan.certificate ?? '(none)'],
    ['Data on destroy', String(config.removalPolicy).toLowerCase()],
    ['Stacks', stacks.join(', ')],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}

/** A warning to show above the plan when the environment is production; undefined otherwise. */
export function productionWarning(plan: AppPlan): string | undefined {
  if (plan.config.name !== 'production') {
    return undefined;
  }
  const rule = '!'.repeat(64);
  const lines = [
    rule,
    '!!  WARNING: THIS DEPLOYS TO THE PRODUCTION ENVIRONMENT',
    `!!  Account ${plan.account}. Check it is the production account.`,
  ];
  if (!plan.production) {
    lines.push('!!  -c production=true is not set: this uses the small, non-production sizing.');
  }
  lines.push(rule);
  return lines.join('\n');
}

/** Only "y" or "yes", in any case, confirms. */
export function isConfirmed(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}
