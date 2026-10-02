import { CfnOutput, RemovalPolicy, SecretValue, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  COGNITO_DIRECTORY,
  EnvironmentConfig,
  OidcProviderConfig,
  identityProviderParameterName,
  identityProviderRedirectUri,
  managedLoginDomainPrefix,
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
  /**
   * Creates `identityProvider` on the new pool as an OIDC provider. Without
   * it the provider is only named, and must be added to the pool by hand.
   * Not for an existing pool, whose provider already exists.
   */
  readonly oidcProvider?: OidcProviderConfig;
}

/**
 * The environment's Cognito user pool: either a new pool or a pointer to an
 * existing one, and the identity provider its users sign in through. Both go
 * into SSM parameters, which is where Web stacks find them, so they don't
 * need to know how the environment was set up.
 *
 * A federated provider on a new pool is created here when its OIDC settings
 * are given, with the same scopes and attribute mapping as VT-SSO-OIDC on the
 * existing VT pool. On an existing pool it is only named.
 */
export class AuthStack extends Stack {
  /** The provisioned pool; undefined when the environment uses an existing one. */
  readonly userPool?: cognito.UserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config, existingUserPoolId, identityProvider = COGNITO_DIRECTORY, oidcProvider } = props;

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

      // Managed login needs a domain.
      const domain = userPool.addDomain('Domain', {
        cognitoDomain: { domainPrefix: managedLoginDomainPrefix(config.name, this.account) },
      });
      new CfnOutput(this, 'ManagedLoginUrl', { value: domain.baseUrl() });
      new CfnOutput(this, 'IdentityProviderRedirectUri', {
        value: identityProviderRedirectUri(config.name, this.account, this.region),
      });

      if (oidcProvider) {
        new cognito.UserPoolIdentityProviderOidc(this, 'OidcProvider', {
          userPool,
          name: identityProvider,
          issuerUrl: oidcProvider.issuerUrl,
          clientId: oidcProvider.clientId,
          // A dynamic reference that CloudFormation resolves at deploy time,
          // so the secret itself is not in the template.
          clientSecret: SecretValue.secretsManager(oidcProvider.secretName).unsafeUnwrap(),
          scopes: ['openid', 'email'],
          attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET,
          attributeMapping: {
            email: cognito.ProviderAttribute.other('email'),
            custom: { username: cognito.ProviderAttribute.other('sub') },
          },
        });
      }
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
