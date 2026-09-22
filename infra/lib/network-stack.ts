import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export interface NetworkStackProps extends cdk.StackProps {
  /** Existing VPC to reuse. Must be supplied together with ebSecurityGroupId. */
  readonly vpcId?: string;
  /** Existing Elastic Beanstalk EC2 security group to reuse. */
  readonly ebSecurityGroupId?: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly ebSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const hasVpcId = Boolean(props.vpcId);
    const hasSecurityGroupId = Boolean(props.ebSecurityGroupId);

    if (hasVpcId !== hasSecurityGroupId) {
      throw new Error(
        "Network import requires both NETWORK_VPC_ID and NETWORK_EB_SECURITY_GROUP_ID, or neither.",
      );
    }

    if (hasVpcId && hasSecurityGroupId) {
      this.vpc = ec2.Vpc.fromLookup(this, "DlpAccessVpc", {
        vpcId: props.vpcId,
      });
      this.ebSecurityGroup = ec2.SecurityGroup.fromLookupById(
        this,
        "ImportedEbSecurityGroup",
        props.ebSecurityGroupId!,
      );
    } else {
      const vpc = new ec2.Vpc(this, "DlpAccessVpc", {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          { name: "public", subnetType: ec2.SubnetType.PUBLIC },
          {
            name: "private-egress",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });

      // gateway endpoints keep S3 traffic on the AWS network instead of sending
      // it through the NAT gateway, which avoids NAT data-processing charges.
      vpc.addGatewayEndpoint("S3GatewayEndpoint", {
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      });

      // cost-saving path for DynamoDB traffic from private subnets.
      vpc.addGatewayEndpoint("DynamoDbGatewayEndpoint", {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      });

      this.vpc = vpc;
      this.ebSecurityGroup = new ec2.SecurityGroup(this, "EbSecurityGroup", {
        vpc,
        description: "Security group for Elastic Beanstalk EC2 instances",
      });
    }

    new cdk.CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      description: "VPC used by the Elastic Beanstalk environment",
    });
    new cdk.CfnOutput(this, "ElasticBeanstalkSecurityGroupId", {
      value: this.ebSecurityGroup.securityGroupId,
      description: "Elastic Beanstalk EC2 security group",
    });
  }
}
