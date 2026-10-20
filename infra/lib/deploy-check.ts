import { AppPlan } from './app';
import { COGNITO_DIRECTORY } from './environments';
import { MODELS, tableName } from './models';
import { webResourceName } from './web-stack';

/**
 * Runs an AWS CLI command and returns its parsed JSON output. Throws an
 * `AwsError` carrying the CLI's message when the command fails.
 */
export type AwsCli = (args: string[]) => any;

export class AwsError extends Error {}

export interface StackState {
  readonly status: string;
  readonly outputs: Readonly<Record<string, string>>;
}

/** What is already deployed under the plan's names. `undefined` means not found. */
export interface DeployedState {
  /** The account the credentials belong to. */
  readonly callerAccount?: string;
  readonly stacks: Readonly<Record<string, StackState | undefined>>;
  /** Tables the Data stack would create that already exist outside it. */
  readonly existingTables: readonly string[];
  /** The search domain's current nodes, when the domain exists. */
  readonly search?: { readonly instanceType: string; readonly dataNodes: number };
  /** The environment the branch's frontend uses now, when it exists. */
  readonly webEnvironment?: string;
  /** Lookups that failed for a reason other than "not found". */
  readonly errors: readonly string[];
}

const NOT_FOUND = /does not exist|not found|ResourceNotFound|NoSuchEntity/i;

/** Looks up the stacks and named resources the plan would create or update. */
export function lookupDeployedState(plan: AppPlan, aws: AwsCli): DeployedState {
  const errors: string[] = [];
  // Runs a lookup; not-found is undefined, anything else is recorded.
  const find = <T>(what: string, lookup: () => T): T | undefined => {
    try {
      return lookup();
    } catch (err) {
      if (!(err instanceof AwsError) || !NOT_FOUND.test(err.message)) {
        errors.push(`${what}: ${(err as Error).message.trim()}`);
      }
      return undefined;
    }
  };

  const callerAccount = find('credentials', () => aws(['sts', 'get-caller-identity']).Account as string);
  if (callerAccount !== plan.account) {
    return { callerAccount, stacks: {}, existingTables: [], errors };
  }

  const stackNames = [plan.dataStackName, plan.apiStackName, plan.authStackName, plan.webStackName].filter(
    (name): name is string => name !== undefined,
  );
  const stacks: Record<string, StackState | undefined> = {};
  for (const name of stackNames) {
    stacks[name] = find(`stack ${name}`, () => {
      const [stack] = aws(['cloudformation', 'describe-stacks', '--stack-name', name]).Stacks;
      const outputs: Record<string, string> = {};
      for (const output of stack.Outputs ?? []) {
        outputs[output.OutputKey] = output.OutputValue;
      }
      return { status: stack.StackStatus as string, outputs };
    });
  }

  const env = plan.config.name;
  let existingTables: string[] = [];
  let search: DeployedState['search'];
  if (plan.dataStackName) {
    if (willCreate(stacks[plan.dataStackName])) {
      existingTables = MODELS.map((model) => tableName(model, env)).filter((table) =>
        find(`table ${table}`, () => aws(['dynamodb', 'describe-table', '--table-name', table])),
      );
    }
    search = find(`search domain dlpnext-${env}`, () => {
      const cluster = aws(['opensearch', 'describe-domain', '--domain-name', `dlpnext-${env}`]).DomainStatus.ClusterConfig;
      return { instanceType: cluster.InstanceType as string, dataNodes: cluster.InstanceCount as number };
    });
  }

  let webEnvironment: string | undefined;
  if (plan.webStackName && plan.branch && !willCreate(stacks[plan.webStackName])) {
    webEnvironment = find(`application ${webResourceName(plan.branch)}`, () => {
      const [app] = aws([
        'elasticbeanstalk',
        'describe-applications',
        '--application-names',
        webResourceName(plan.branch!),
      ]).Applications;
      return /using the (\S+) environment$/.exec(app?.Description ?? '')?.[1];
    });
  }

  return { callerAccount, stacks, existingTables, search, webEnvironment, errors };
}

/** A stack that doesn't exist, or whose last create never ran, is created. */
function willCreate(stack: StackState | undefined): boolean {
  return stack === undefined || stack.status === 'REVIEW_IN_PROGRESS' || stack.status === 'ROLLBACK_COMPLETE';
}

export interface DeployCheck {
  /** One line per stack: whether it is created or updated. */
  readonly stacks: string[];
  /** Changes or problems the person deploying should see before confirming. */
  readonly warnings: string[];
}

/** Compares the plan with what is deployed. */
export function checkDeploy(plan: AppPlan, state: DeployedState): DeployCheck {
  const warnings = [...state.errors.map((error) => `Couldn't check ${error}`)];
  if (state.callerAccount !== undefined && state.callerAccount !== plan.account) {
    warnings.push(
      `The credentials are for account ${state.callerAccount}, not ${plan.account}: the deploy will fail. Nothing else was checked.`,
    );
    return { stacks: [], warnings };
  }

  const stacks: string[] = [];
  for (const [name, stack] of Object.entries(state.stacks)) {
    if (stack === undefined) {
      stacks.push(`${name}: create`);
    } else if (stack.status === 'REVIEW_IN_PROGRESS') {
      stacks.push(`${name}: create (an earlier create of it failed before starting)`);
    } else if (stack.status === 'ROLLBACK_COMPLETE') {
      stacks.push(`${name}: create (replaces a stack whose create failed and rolled back)`);
    } else if (stack.status.endsWith('_IN_PROGRESS')) {
      stacks.push(`${name}: busy (now ${stack.status})`);
      warnings.push(`${name} is ${stack.status}: the deploy will fail until that finishes.`);
    } else {
      stacks.push(`${name}: update (now ${stack.status})`);
    }
  }

  if (state.existingTables.length > 0) {
    warnings.push(
      `Tables already exist outside the ${plan.dataStackName} stack, so creating it will fail: ${state.existingTables.join(', ')}. ` +
        'Delete them (turn off deletion protection first) or import them into the stack.',
    );
  }

  const search = plan.config.search;
  const data = plan.dataStackName ? state.stacks[plan.dataStackName] : undefined;
  if (state.search && plan.dataStackName) {
    const current = `${state.search.dataNodes} x ${state.search.instanceType}`;
    const planned = `${search.dataNodes} x ${search.instanceType}`;
    if (willCreate(data)) {
      warnings.push(
        `Search domain dlpnext-${plan.config.name} already exists outside the ${plan.dataStackName} stack, so creating it will fail.`,
      );
    } else if (current !== planned) {
      const smaller = search.dataNodes < state.search.dataNodes;
      warnings.push(
        `Changes search from ${current} to ${planned}` +
          (smaller ? ' (smaller: was -c production=true left out?)' : '') +
          '. Resizing a domain takes a while.',
      );
    }
  }

  const auth = plan.authStackName ? state.stacks[plan.authStackName] : undefined;
  if (auth && !willCreate(auth)) {
    const pool = auth.outputs.UserPoolId;
    if (pool !== undefined && pool !== plan.userPool) {
      warnings.push(`Repoints the ${plan.config.name} environment's user pool from ${pool} to ${plan.userPool}.`);
    }
    const provider = auth.outputs.IdentityProvider;
    const plannedProvider = plan.identityProvider ?? COGNITO_DIRECTORY;
    if (provider !== undefined && provider !== plannedProvider) {
      warnings.push(
        `Changes sign-in from ${provider} to ${plannedProvider}` +
          (plan.identityProvider === undefined ? ' (was -c identityProvider left out?)' : '') +
          '.',
      );
    }
    if ((pool !== undefined && pool !== plan.userPool) || (provider !== undefined && provider !== plannedProvider)) {
      warnings.push("The environment's frontends pick up a sign-in change only when each is redeployed.");
    }
  }

  const web = plan.webStackName ? state.stacks[plan.webStackName] : undefined;
  if (web && !willCreate(web)) {
    if (state.webEnvironment !== undefined && state.webEnvironment !== plan.config.name) {
      warnings.push(
        `Moves the frontend ${plan.webStackName} from the ${state.webEnvironment} environment to ${plan.config.name}, ` +
          "including its sign-in client, which moves to that environment's user pool.",
      );
    }
    const deployedBranch = web.outputs.Branch;
    if (deployedBranch !== undefined && deployedBranch !== plan.branchName) {
      warnings.push(
        `${plan.webStackName} was deployed from the branch ${deployedBranch}, not ${plan.branchName}: ` +
          'the two names have the same slug, so this replaces that branch\'s frontend.',
      );
    }
  }

  return { stacks, warnings };
}
