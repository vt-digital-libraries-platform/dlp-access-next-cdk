#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { buildApp, optionsFromContext } from '../lib/app';

const app = new cdk.App();
buildApp(app, optionsFromContext((key) => app.node.tryGetContext(key)));
