#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { booleanContext, buildApp } from '../lib/app';

const app = new cdk.App();
const context = (key: string) => app.node.tryGetContext(key);
buildApp(app, {
  env: context('env'),
  account: context('account'),
  production: booleanContext('production', context('production')),
  branch: context('branch'),
  backend: context('backend'),
});
