import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvironmentConfig, userPoolIdParameterName } from './environments';

/** The group whose members may use the app's admin-only pages. */
export const ADMIN_GROUP = 'admin';

export interface AuthStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /**
   * ID of an existing Cognito user pool for the environment to use. Omit to
   * provision a new one.
   */
  readonly existingUserPoolId?: string;
}

/**
 * The environment's Cognito user pool: either a new pool or a pointer to an
 * existing one. Either way the pool's ID goes into an SSM parameter, which is
 * where Web stacks find it, so they don't need to know which kind it is.
 */
export class AuthStack extends Stack {
  /** The provisioned pool; undefined when the environment uses an existing one. */
  readonly userPool?: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config, existingUserPoolId } = props;

    let userPoolId = existingUserPoolId;
    if (userPoolId === undefined) {
      const retain = config.removalPolicy === RemovalPolicy.RETAIN;
      // Users are created by an administrator and sign in with their email.
      const userPool = new cognito.UserPool(this, 'UserPool', {
        userPoolName: `dlpnext-${config.name}`,
        selfSignUpEnabled: false,
        signInAliases: { email: true },
        autoVerify: { email: true },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        deletionProtection: retain,
        removalPolicy: config.removalPolicy,
      });
      this.userPool = userPool;
      userPoolId = userPool.userPoolId;

      new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
        userPoolId,
        groupName: ADMIN_GROUP,
        description: 'May use the admin-only pages of the Next.js app',
      });

      // Managed login needs a domain. Prefixes are unique per region across
      // all accounts, so the account ID is part of it.
      const domain = userPool.addDomain('Domain', {
        cognitoDomain: { domainPrefix: `dlpnext-${config.name}-${this.account}` },
      });
      new CfnOutput(this, 'ManagedLoginUrl', { value: domain.baseUrl() });
    }

    new ssm.StringParameter(this, 'UserPoolIdParameter', {
      parameterName: userPoolIdParameterName(config.name),
      stringValue: userPoolId,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPoolId });
  }
}
