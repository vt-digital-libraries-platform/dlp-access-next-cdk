import { planApp } from '../lib/app';
import { AwsCli, AwsError, checkDeploy, lookupDeployedState } from '../lib/deploy-check';

const account = '123456789012';
const userPool = 'us-east-1_AbCd12345';
const certificate = `arn:aws:acm:us-east-1:${account}:certificate/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7`;

const provision = planApp({ env: 'dev', account, userPool, identityProvider: 'VT-SSO-OIDC' });
const attach = planApp({ env: 'dev', account, branch: 'whunter/Multi_Env', certificate });

/**
 * A fake AWS CLI: `resources` maps "service command name" to the parsed
 * output, or to an Error to throw (a command without a name argument is just
 * "service command"). Anything missing is "not found".
 */
function fakeAws(resources: Record<string, unknown>, caller = account): AwsCli {
  return (args) => {
    const [service, command] = args;
    if (service === 'sts') {
      return { Account: caller };
    }
    const key = args.length > 2 ? `${service} ${command} ${args[3]}` : `${service} ${command}`;
    const found = resources[key];
    if (found instanceof Error) {
      throw found;
    }
    if (found === undefined) {
      throw new AwsError(`An error occurred (ValidationError): ${args[3]} does not exist`);
    }
    return found;
  };
}

const stack = (status: string, outputs: Record<string, string> = {}) => ({
  Stacks: [{ StackStatus: status, Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }],
});
const domain = (instanceType: string, count: number) => ({
  DomainStatus: { ClusterConfig: { InstanceType: instanceType, InstanceCount: count } },
});
const deployedBackend = {
  'cloudformation describe-stacks DlpAccessNext-dev-Data': stack('UPDATE_COMPLETE'),
  'cloudformation describe-stacks DlpAccessNext-dev-Api': stack('UPDATE_COMPLETE'),
  'cloudformation describe-stacks DlpAccessNext-dev-Auth': stack('CREATE_COMPLETE', {
    UserPoolId: userPool,
    IdentityProvider: 'VT-SSO-OIDC',
  }),
  'opensearch describe-domain dlpnext-dev': domain('t3.small.search', 1),
};

const check = (plan: typeof provision, resources: Record<string, unknown>, caller?: string) =>
  checkDeploy(plan, lookupDeployedState(plan, fakeAws(resources, caller)));

describe('checkDeploy', () => {
  test('a new backend is created, with nothing to warn about', () => {
    expect(check(provision, {})).toEqual({
      stacks: ['DlpAccessNext-dev-Data: create', 'DlpAccessNext-dev-Api: create', 'DlpAccessNext-dev-Auth: create'],
      warnings: [],
    });
  });

  test('a redeploy with the same settings is an update, with nothing to warn about', () => {
    const { stacks, warnings } = check(provision, deployedBackend);
    expect(stacks).toEqual([
      'DlpAccessNext-dev-Data: update (now UPDATE_COMPLETE)',
      'DlpAccessNext-dev-Api: update (now UPDATE_COMPLETE)',
      'DlpAccessNext-dev-Auth: update (now CREATE_COMPLETE)',
    ]);
    expect(warnings).toEqual([]);
  });

  test('warns about tables and a search domain left outside a Data stack being created', () => {
    const { stacks, warnings } = check(provision, {
      'cloudformation describe-stacks DlpAccessNext-dev-Data': stack('REVIEW_IN_PROGRESS'),
      'dynamodb list-tables': { TableNames: ['Archive-dlpnext-dev', 'Archive-dlpnext-f-other', 'Site-dlpnext-dev'] },
      'opensearch describe-domain dlpnext-dev': domain('t3.small.search', 1),
    });
    expect(stacks[0]).toMatch(/Data: create \(an earlier create/);
    expect(warnings).toEqual([
      expect.stringMatching(/^Tables already exist outside .*: Archive-dlpnext-dev, Site-dlpnext-dev\./),
      expect.stringMatching(/^Search domain dlpnext-dev already exists outside/),
    ]);
  });

  test('warns when the user pool or identity provider changes', () => {
    const plan = planApp({ env: 'dev', account, userPool: 'us-east-1_Other1234' });
    expect(check(plan, deployedBackend).warnings).toEqual([
      `Repoints the dev environment's user pool from ${userPool} to us-east-1_Other1234.`,
      'Changes sign-in from VT-SSO-OIDC to COGNITO (was -c identityProvider left out?).',
      expect.stringMatching(/frontends pick up a sign-in change only when each is redeployed/),
    ]);
  });

  test('warns when production is redeployed without -c production=true', () => {
    const plan = planApp({ env: 'production', account, userPool, identityProvider: 'VT-SSO-OIDC' });
    const { warnings } = check(plan, {
      'cloudformation describe-stacks DlpAccessNext-production-Data': stack('UPDATE_COMPLETE'),
      'opensearch describe-domain dlpnext-production': domain('m7g.medium.search', 3),
    });
    expect(warnings).toEqual([
      'Changes search from 3 x m7g.medium.search to 1 x t3.small.search (smaller: was -c production=true left out?). Resizing a domain takes a while.',
    ]);
  });

  test('warns when a frontend moves to another environment', () => {
    const { stacks, warnings } = check(attach, {
      'cloudformation describe-stacks DlpAccessNext-Web-whunter-multi-env': stack('UPDATE_COMPLETE', {
        Branch: 'whunter/Multi_Env',
      }),
      'elasticbeanstalk describe-applications dlpnext-whunter-multi-env': {
        Applications: [{ Description: 'dlp-access-next branch whunter-multi-env, using the f-search environment' }],
      },
    });
    expect(stacks).toEqual(['DlpAccessNext-Web-whunter-multi-env: update (now UPDATE_COMPLETE)']);
    expect(warnings).toEqual([expect.stringMatching(/^Moves the frontend .* from the f-search environment to dev/)]);
  });

  test('warns when another branch name with the same slug owns the frontend', () => {
    const { warnings } = check(attach, {
      'cloudformation describe-stacks DlpAccessNext-Web-whunter-multi-env': stack('UPDATE_COMPLETE', {
        Branch: 'whunter-multi-env',
      }),
      'elasticbeanstalk describe-applications dlpnext-whunter-multi-env': {
        Applications: [{ Description: 'dlp-access-next branch whunter-multi-env, using the dev environment' }],
      },
    });
    expect(warnings).toEqual([expect.stringMatching(/deployed from the branch whunter-multi-env, not whunter\/Multi_Env/)]);
  });

  test('warns about a stack with an operation in progress', () => {
    const { stacks, warnings } = check(attach, {
      'cloudformation describe-stacks DlpAccessNext-Web-whunter-multi-env': stack('UPDATE_IN_PROGRESS'),
    });
    expect(stacks).toEqual(['DlpAccessNext-Web-whunter-multi-env: busy (now UPDATE_IN_PROGRESS)']);
    expect(warnings).toEqual([expect.stringMatching(/is UPDATE_IN_PROGRESS: the deploy will fail/)]);
  });

  test('stops at credentials for another account', () => {
    expect(check(provision, deployedBackend, '210987654321')).toEqual({
      stacks: [],
      warnings: [expect.stringMatching(/credentials are for account 210987654321, not 123456789012/)],
    });
  });

  test('reports lookups that fail for reasons other than not found', () => {
    const { stacks, warnings } = check(provision, {
      ...deployedBackend,
      'cloudformation describe-stacks DlpAccessNext-dev-Api': new AwsError('AccessDenied: not authorized'),
    });
    expect(stacks).toContain('DlpAccessNext-dev-Api: create');
    expect(warnings).toEqual(["Couldn't check stack DlpAccessNext-dev-Api: AccessDenied: not authorized"]);
  });
});
