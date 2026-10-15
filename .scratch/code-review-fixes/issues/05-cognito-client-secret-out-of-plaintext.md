# 05: The Cognito client secret is kept out of plain-text Beanstalk settings

**What to build:** The Web stack's Cognito app client secret is no longer readable as plain text in the Beanstalk console or through `elasticbeanstalk:DescribeConfigurationSettings`. Today it is set directly as the `COGNITO_CLIENT_SECRET` environment property. The secret should be stored encrypted, only the environment's instance role should be able to read it, and the Next.js server should still get it at runtime.

The storage choice is open: Secrets Manager, an SSM SecureString, or Beanstalk's own environment secret references. Pick one based on how it gets populated from the app client's secret, which CloudFormation only exposes as an attribute, and on how the server reads it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [ ] Decide where the secret is stored and how the server reads it
- [ ] The Beanstalk environment's configuration no longer contains the secret in plain text
- [ ] Only that environment's instance role can read the secret
- [ ] Sign-in still works on a deployed Web stack
- [ ] Running a branch locally still has a documented way to get the secret
- [ ] Jest template assertions cover the change (`npm test` passes), and CLAUDE.md is updated
