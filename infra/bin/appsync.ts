#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { buildApp } from '../lib/app';

const app = new cdk.App();
buildApp(app, app.node.tryGetContext('env'));
