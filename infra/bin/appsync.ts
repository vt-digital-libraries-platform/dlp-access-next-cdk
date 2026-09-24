#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { buildApp } from '../lib/app';

const app = new cdk.App();
const context = (key: string) => app.node.tryGetContext(key);
buildApp(app, { env: context('env'), branch: context('branch'), backend: context('backend') });
