import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * Per-environment settings. Everything that differs between environments
 * lives here so the differences can be reviewed in one place.
 */
export interface EnvironmentConfig {
  /** Environment name as passed with `-c env=<name>`. */
  readonly name: string;
  readonly account: string;
  readonly region: string;
  readonly search: {
    readonly instanceType: string;
    readonly dataNodes: number;
    /** 1 disables zone awareness; 2 or 3 spreads nodes across that many AZs. */
    readonly availabilityZones: number;
    readonly volumeSizeGiB: number;
  };
  /**
   * RETAIN also turns on table deletion protection and point-in-time
   * recovery; DESTROY turns both off.
   */
  readonly removalPolicy: RemovalPolicy;
}

const DEV_ACCOUNT = '226388486048';
const PRODUCTION_ACCOUNT_PLACEHOLDER = 'PRODUCTION_ACCOUNT_ID';

const SMALL_SEARCH: EnvironmentConfig['search'] = {
  instanceType: 't3.small.search',
  dataNodes: 1,
  availabilityZones: 1,
  volumeSizeGiB: 10,
};

type Settings = Omit<EnvironmentConfig, 'name'>;

const ENVIRONMENTS: Record<string, Settings> = {
  dev: {
    account: DEV_ACCOUNT,
    region: 'us-east-1',
    search: SMALL_SEARCH,
    removalPolicy: RemovalPolicy.DESTROY,
  },
  'pre-production': {
    account: DEV_ACCOUNT,
    region: 'us-east-1',
    search: SMALL_SEARCH,
    removalPolicy: RemovalPolicy.RETAIN,
  },
  production: {
    // Separate AWS account. Fill in before the first production deploy.
    account: PRODUCTION_ACCOUNT_PLACEHOLDER,
    region: 'us-east-1',
    search: {
      instanceType: 'm7g.medium.search',
      dataNodes: 2,
      availabilityZones: 2,
      volumeSizeGiB: 10,
    },
    removalPolicy: RemovalPolicy.RETAIN,
  },
};

/** Feature environments are short-lived, prefixed `f-`, and use dev's settings. */
const FEATURE_PREFIX = 'f-';

// OpenSearch domain names are at most 28 characters and the domain is named
// `dlpnext-<env>`, which leaves 20 for the environment name.
const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

export function resolveEnvironment(name: string | undefined): EnvironmentConfig {
  if (!name) {
    throw new Error(
      `Missing CDK context: pass -c env=<name>, one of ${Object.keys(ENVIRONMENTS).join(', ')} or ${FEATURE_PREFIX}<slug>`,
    );
  }
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid environment name "${name}": use lowercase letters, digits and hyphens, starting with a letter, at most 20 characters`,
    );
  }
  const settings = ENVIRONMENTS[name] ?? (name.startsWith(FEATURE_PREFIX) ? ENVIRONMENTS.dev : undefined);
  if (!settings) {
    throw new Error(
      `Unknown environment "${name}": use one of ${Object.keys(ENVIRONMENTS).join(', ')} or ${FEATURE_PREFIX}<slug> for a feature environment`,
    );
  }
  if (settings.account === PRODUCTION_ACCOUNT_PLACEHOLDER) {
    throw new Error(`Environment "${name}" has no AWS account configured yet (see lib/environments.ts)`);
  }
  return { name, ...settings };
}
