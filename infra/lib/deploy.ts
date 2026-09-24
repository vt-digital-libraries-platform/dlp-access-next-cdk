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

/** The confirmation text shown before deploying. */
export function describePlan(plan: AppPlan): string {
  const { config } = plan;
  const search = config.search;
  const stacks = [plan.dataStackName, plan.apiStackName, plan.webStackName].filter(Boolean);
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
