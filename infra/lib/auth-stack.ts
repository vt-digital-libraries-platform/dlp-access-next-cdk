import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  COGNITO_DIRECTORY,
  EnvironmentConfig,
  identityProviderParameterName,
  userPoolIdParameterName,
} from './environments';

/** The group whose members may use the app's admin-only pages. */
export const ADMIN_GROUP = 'admin';

export interface AuthStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /**
   * ID of an existing Cognito user pool for the environment to use. Omit to
   * provision a new one.
   */
  readonly existingUserPoolId?: string;
  /**
   * Name of the federated identity provider, configured on the user pool,
   * that users sign in through. Omit for the pool's own users.
   */
  readonly identityProvider?: string;
}

/**
 * The environment's Cognito user pool: either a new pool or a pointer to an
 * existing one, and the identity provider its users sign in through. Both go
 * into SSM parameters, which is where Web stacks find them, so they don't
 * need to know how the environment was set up.
 *
 * A federated provider is only named here, not created: registering the pool
 * with the provider and adding it to the pool is done outside CDK, because it
 * needs credentials issued by the provider.
 */
export class AuthStack extends Stack {
  /** The provisioned pool; undefined when the environment uses an existing one. */
  readonly userPool?: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config, existingUserPoolId, identityProvider = COGNITO_DIRECTORY } = props;

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

    new ssm.StringParameter(this, 'IdentityProviderParameter', {
      parameterName: identityProviderParameterName(config.name),
      stringValue: identityProvider,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPoolId });
    new CfnOutput(this, 'IdentityProvider', { value: identityProvider });
  }
}
