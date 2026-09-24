import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * Per-environment settings. Everything that differs between environments
 * lives here so the differences can be reviewed in one place. Sizing
 * (`search`, `web`) comes from the `production` flag rather than the
 * environment name.
 */
export interface EnvironmentConfig {
  /** Environment name as passed with `-c env=<name>`. */
  readonly name: string;
  readonly region: string;
  readonly search: {
    readonly instanceType: string;
    readonly dataNodes: number;
    /** 1 disables zone awareness; 2 or 3 spreads nodes across that many AZs. */
    readonly availabilityZones: number;
    readonly volumeSizeGiB: number;
  };
  /** Elastic Beanstalk settings for each branch deployment of the Next.js app. */
  readonly web: {
    readonly instanceType: string;
  };
  /**
   * RETAIN also turns on table deletion protection and point-in-time
   * recovery; DESTROY turns both off.
   */
  readonly removalPolicy: RemovalPolicy;
}

type Sizing = Pick<EnvironmentConfig, 'search' | 'web'>;

/** Sizing with `-c production=false` (the default): one small search node. */
const STANDARD_SIZING: Sizing = {
  search: {
    instanceType: 't3.small.search',
    dataNodes: 1,
    availabilityZones: 1,
    volumeSizeGiB: 10,
  },
  web: { instanceType: 't3.small' },
};

/** Sizing with `-c production=true`: three search nodes, one per AZ. */
const PRODUCTION_SIZING: Sizing = {
  search: {
    instanceType: 'm7g.medium.search',
    dataNodes: 3,
    availabilityZones: 3,
    volumeSizeGiB: 10,
  },
  web: { instanceType: 't3.medium' },
};

type Settings = Omit<EnvironmentConfig, 'name' | keyof Sizing>;

const ENVIRONMENTS: Record<string, Settings> = {
  dev: {
    region: 'us-east-1',
    removalPolicy: RemovalPolicy.RETAIN,
  },
  'pre-production': {
    region: 'us-east-1',
    removalPolicy: RemovalPolicy.RETAIN,
  },
  production: {
    region: 'us-east-1',
    removalPolicy: RemovalPolicy.RETAIN,
  },
};

/**
 * Feature environments are short-lived and prefixed `f-`. They are the only
 * environments whose data is destroyed with their stacks.
 */
const FEATURE_PREFIX = 'f-';
const FEATURE: Settings = {
  ...ENVIRONMENTS.dev,
  removalPolicy: RemovalPolicy.DESTROY,
};

// OpenSearch domain names are at most 28 characters and the domain is named
// `dlpnext-<env>`, which leaves 20 for the environment name.
const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;

export function resolveEnvironment(name: string | undefined, production = false): EnvironmentConfig {
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
  const settings = ENVIRONMENTS[name] ?? (name.startsWith(FEATURE_PREFIX) ? FEATURE : undefined);
  if (!settings) {
    throw new Error(
      `Unknown environment "${name}": use one of ${Object.keys(ENVIRONMENTS).join(', ')} or ${FEATURE_PREFIX}<slug> for a feature environment`,
    );
  }
  return { name, ...settings, ...(production ? PRODUCTION_SIZING : STANDARD_SIZING) };
}

// Names that stacks deployed separately use to find each other. A Web stack
// can attach to an environment whose Api stack is not in the same CDK app,
// so these are fixed names rather than cross-stack references.

/** The environment's Elastic Beanstalk instance role and profile. */
export function ebInstanceProfileName(envName: string): string {
  return `dlp-access-next-${envName}-eb`;
}

/** SSM parameter holding the environment's GraphQL API URL. */
export function graphqlApiUrlParameterName(envName: string): string {
  return `/dlp-access-next/${envName}/graphql-api-url`;
}
