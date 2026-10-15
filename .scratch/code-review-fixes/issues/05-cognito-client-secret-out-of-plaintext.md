# 05: The Cognito client secret is kept out of plain-text Beanstalk settings

**What to build:** The Web stack's Cognito app client secret is no longer readable as plain text in the Beanstalk console or through `elasticbeanstalk:DescribeConfigurationSettings`. Today it is set directly as the `COGNITO_CLIENT_SECRET` environment property. The secret should be stored encrypted, only the environment's instance role should be able to read it, and the Next.js server should still get it at runtime.

The storage choice is open: Secrets Manager, an SSM SecureString, or Beanstalk's own environment secret references. Pick one based on how it gets populated from the app client's secret, which CloudFormation only exposes as an attribute, and on how the server reads it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [x] Decide where the secret is stored and how the server reads it
- [x] The Beanstalk environment's configuration no longer contains the secret in plain text
- [x] Only that environment's instance role can read the secret
- [ ] Sign-in still works on a deployed Web stack
- [x] Running a branch locally still has a documented way to get the secret
- [x] Jest template assertions cover the change (`npm test` passes), and CLAUDE.md is updated

## Comments

Implemented: the Web stack stores the secret in a Secrets Manager secret whose value is the app client's `ClientSecret` attribute (generated name, deleted with the stack, default `aws/secretsmanager` key). The Beanstalk environment gets it as `COGNITO_CLIENT_SECRET` through the `aws:elasticbeanstalk:application:environmentsecrets` namespace, whose value is the secret ARN, so the server code is unchanged. An SSM SecureString was ruled out because CloudFormation can't create one. The Web stack grants `GetSecretValue` to the environment's instance role (`dlp-access-next-<env>-eb`, imported by name) and the environment depends on that policy. The new `CognitoClientSecretArn` output is used with `aws secretsmanager get-secret-value` for local runs.

Caveats: the instance role is shared by every branch of the environment, so those branches can read each other's secrets. The secret has no resource policy, so account principals with broad Secrets Manager access can read it as before. Beanstalk reads the secret when an instance starts or a deploy runs. Replacing the app client also changes `COGNITO_CLIENT_ID`, which should update the environment, but that hasn't been tested.

Still open: sign-in on a deployed Web stack has to be checked after a user-run deploy (`npm run deploy -- -c env=dev -c account=$ACCOUNT -c branch=$(git branch --show-current)`). Close this ticket once that works.
