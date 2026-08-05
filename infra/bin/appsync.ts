#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppSyncStack } from '../lib/appsync-stack';

const app = new cdk.App();

const tableSuffix = app.node.tryGetContext('tableSuffix') ?? 'bxbkjhe235e3jcwcjcji5txvlm-vtdlpdev';
const ebInstanceRoleName = app.node.tryGetContext('ebInstanceRoleName') ?? 'aws-elasticbeanstalk-ec2-role';

new AppSyncStack(app, 'DlpAccessNextAppSyncStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  tableSuffix,
  ebInstanceRoleName,
});
