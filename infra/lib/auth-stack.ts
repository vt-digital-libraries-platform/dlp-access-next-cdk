import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  COGNITO_DIRECTORY,
  EnvironmentConfig,
  identityProviderParameterName,
  userPoolIdParameterName,
} from './environments';

export interface AuthStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** ID of the existing Cognito user pool the environment uses. */
  readonly userPoolId: string;
  /**
   * Name of the federated identity provider, configured on the user pool,
   * that users sign in through. Omit for the pool's own users.
   */
  readonly identityProvider?: string;
}

/**
 * Points the environment at its Cognito user pool and the identity provider
 * its users sign in through. Both go into SSM parameters, which is where Web
 * stacks find them. The pool and its provider are made outside CDK and are
 * not changed here.
 */
export class AuthStack extends Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config, userPoolId, identityProvider = COGNITO_DIRECTORY } = props;

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
