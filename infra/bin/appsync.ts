#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AppSyncStack } from "../lib/appsync-stack";
import { NetworkStack } from "../lib/network-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

new NetworkStack(app, "DlpAccessNextNetworkStack", {
  env,
  vpcId: process.env.NETWORK_VPC_ID,
  ebSecurityGroupId: process.env.NETWORK_EB_SECURITY_GROUP_ID,
});

const tableSuffix =
  app.node.tryGetContext("tableSuffix") ??
  "bxbkjhe235e3jcwcjcji5txvlm-vtdlpdev";
const ebInstanceRoleName =
  app.node.tryGetContext("ebInstanceRoleName") ??
  "aws-elasticbeanstalk-ec2-role";
const openSearchDomainEndpoint = app.node.tryGetContext(
  "openSearchDomainEndpoint",
);
if (!openSearchDomainEndpoint) {
  throw new Error(
    "Missing CDK context: pass -c openSearchDomainEndpoint=<existing OpenSearch domain endpoint>",
  );
}

new AppSyncStack(app, "DlpAccessNextAppSyncStack", {
  env,
  tableSuffix,
  ebInstanceRoleName,
  openSearchDomainEndpoint,
});
