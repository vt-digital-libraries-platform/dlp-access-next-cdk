import * as fs from "fs";
import * as path from "path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  booleanContext,
  buildApp,
  optionsFromContext,
  planApp,
} from "../lib/app";
import {
  buildSearchMappings,
  numericSortFields,
  searchMappings,
} from "../lib/appsync/search-mappings";
import { resolveEnvironment } from "../lib/config/environments";
import { ApiStack } from "../lib/stacks/api-stack";
import { DataStack } from "../lib/stacks/data-stack";

const awsAccountId = "123456789012";
const userPoolId = "us-east-1_AbCd12345";

function synth(envName: string) {
  const { data, api } = buildApp(new App(), {
    backendEnv: envName,
    awsAccountId,
    userPoolId,
  });
  return { data: Template.fromStack(data!), api: Template.fromStack(api!) };
}

const roleLogicalId = (template: Template, roleName: string) =>
  Object.entries(template.findResources("AWS::IAM::Role")).find(
    ([, r]) => r.Properties.RoleName === roleName,
  )![0];

const stackNames = (app: App) =>
  app.node.children
    .filter((c): c is Stack => c instanceof Stack)
    .map((s) => s.stackName);

const dev = synth("dev");
const preProduction = synth("pre-production");
const feature = synth("f-search");

describe("environment selection", () => {
  test("stacks are named after the environment", () => {
    const app = new App();
    const { data, api, auth } = buildApp(app, {
      backendEnv: "f-search",
      awsAccountId,
      userPoolId,
    });
    expect(stackNames(app).sort()).toEqual([
      "DlpAccessNext-f-search-Api",
      "DlpAccessNext-f-search-Auth",
      "DlpAccessNext-f-search-Data",
    ]);
    expect(data!.stackName).toBe("DlpAccessNext-f-search-Data");
    expect(api!.stackName).toBe("DlpAccessNext-f-search-Api");
    expect(auth!.stackName).toBe("DlpAccessNext-f-search-Auth");
  });

  test.each([
    [undefined, /Missing CDK context/],
    ["staging", /Unknown environment "staging"/],
    ["f-this-name-is-far-too-long", /Invalid environment name/],
    ["Dev", /Invalid environment name/],
  ])("rejects env %p", (envName, message) => {
    expect(() =>
      buildApp(new App(), { backendEnv: envName, awsAccountId }),
    ).toThrow(message);
  });

  test.each([
    [undefined, undefined],
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
  ])("reads boolean context %p as %p", (value, expected) => {
    expect(booleanContext("production", value)).toBe(expected);
  });

  test.each(["yes", "1", 1])("rejects boolean context %p", (value) => {
    expect(() => booleanContext("production", value)).toThrow(
      /Invalid production/,
    );
  });

  test("production uses the account passed in", () => {
    const { data } = buildApp(new App(), {
      backendEnv: "production",
      awsAccountId,
      userPoolId,
    });
    expect(data!.account).toBe(awsAccountId);
  });

  test.each([
    [undefined, /Missing CDK context: pass -c aws-account-id/],
    ["12345", /Invalid aws-account-id "12345"/],
    ["12345678901x", /Invalid aws-account-id/],
  ])("rejects account %p", (badAccount, message) => {
    expect(() =>
      buildApp(new App(), { backendEnv: "dev", awsAccountId: badAccount }),
    ).toThrow(message);
  });
});

describe("frontend options", () => {
  test.each([
    ["frontendBranch", "frontend-branch", "main"],
    ["backend", "backend", "provision"],
    [
      "certificate",
      "certificate",
      "arn:aws:acm:us-east-1:123456789012:certificate/x",
    ],
  ] as const)(
    "rejects %s: the CDK app deploys only backends",
    (field, option, value) => {
      expect(() =>
        planApp({
          backendEnv: "dev",
          awsAccountId,
          userPoolId,
          [field]: value,
        }),
      ).toThrow(new RegExp(`-c ${option} .*npm run frontend:deploy`));
    },
  );

  test.each(["frontend-branch", "backend", "certificate"])(
    "rejects -c %s passed as CDK context",
    (option) => {
      const context: Record<string, unknown> = {
        "backend-env": "dev",
        "aws-account-id": awsAccountId,
        "user-pool-id": userPoolId,
        [option]: "x",
      };
      expect(() => planApp(optionsFromContext((key) => context[key]))).toThrow(
        /npm run frontend:deploy/,
      );
    },
  );

  test("no stack holds a frontend's Beanstalk, Cognito client or DNS resources", () => {
    const { data, api, auth } = buildApp(new App(), {
      backendEnv: "dev",
      awsAccountId,
      userPoolId,
      identityProvider: "VT-SSO-OIDC",
    });
    for (const stack of [data, api, auth]) {
      const types = Object.values(
        Template.fromStack(stack).toJSON().Resources,
      ).map((resource) => (resource as { Type: string }).Type);
      expect(
        types.filter(
          (type) =>
            type.startsWith("AWS::ElasticBeanstalk::") ||
            type === "AWS::Cognito::UserPoolClient" ||
            type.startsWith("AWS::Route53::"),
        ),
      ).toEqual([]);
    }
  });
});

describe("tables", () => {
  test("seven tables named <Model>-dlpnext-<env> with Amplify key and stream shape", () => {
    dev.data.resourceCountIs("AWS::DynamoDB::Table", 7);
    for (const model of [
      "Archive",
      "Collection",
      "Site",
      "Partner",
      "History",
      "MetadataField",
      "PageContent",
    ]) {
      dev.data.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: `${model}-dlpnext-dev`,
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
        StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
      });
    }
  });

  test("GSIs match the Amplify tables", () => {
    const gsi = (IndexName: string, attribute: string) => ({
      IndexName,
      KeySchema: [{ AttributeName: attribute, KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
    });
    const expected: Record<string, object[]> = {
      Archive: [
        gsi("Identifier", "identifier"),
        gsi("gsi-Collection.archives", "collectionArchivesId"),
      ],
      Collection: [gsi("Identifier", "identifier")],
      Site: [gsi("SiteId", "siteId")],
      Partner: [gsi("Identifier", "identifier")],
    };
    for (const [model, indexes] of Object.entries(expected)) {
      dev.data.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: `${model}-dlpnext-dev`,
        GlobalSecondaryIndexes: Match.arrayWith(
          indexes.map((i) => Match.objectLike(i)),
        ),
      });
    }
    for (const model of ["History", "MetadataField", "PageContent"]) {
      dev.data.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: `${model}-dlpnext-dev`,
        GlobalSecondaryIndexes: Match.absent(),
      });
    }
  });

  test("feature tables are destroyed with the stack and unprotected", () => {
    const tables = Object.values(
      feature.data.findResources("AWS::DynamoDB::Table"),
    );
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.DeletionPolicy).toBe("Delete");
      expect(table.Properties.DeletionProtectionEnabled).toBe(false);
      expect(
        table.Properties.PointInTimeRecoverySpecification
          .PointInTimeRecoveryEnabled,
      ).toBe(false);
    }
  });

  test("dev and pre-production tables are retained, deletion-protected and have PITR", () => {
    for (const { data } of [dev, preProduction]) {
      const tables = Object.values(data.findResources("AWS::DynamoDB::Table"));
      expect(tables).toHaveLength(7);
      for (const table of tables) {
        expect(table.DeletionPolicy).toBe("Retain");
        expect(table.Properties.DeletionProtectionEnabled).toBe(true);
        expect(
          table.Properties.PointInTimeRecoverySpecification
            .PointInTimeRecoveryEnabled,
        ).toBe(true);
      }
    }
  });
});

describe("search domain", () => {
  test("OpenSearch 2.19, encrypted, HTTPS with TLS 1.2, no access policy", () => {
    dev.data.hasResourceProperties("AWS::OpenSearchService::Domain", {
      DomainName: "dlpnext-dev",
      EngineVersion: "OpenSearch_2.19",
      EncryptionAtRestOptions: { Enabled: true },
      NodeToNodeEncryptionOptions: { Enabled: true },
      DomainEndpointOptions: {
        EnforceHTTPS: true,
        TLSSecurityPolicy: "Policy-Min-TLS-1-2-2019-07",
      },
      AccessPolicies: Match.absent(),
    });
  });

  test("without the production flag, domains are one small node", () => {
    const production = synth("production");
    for (const { data } of [dev, preProduction, feature, production]) {
      data.hasResourceProperties("AWS::OpenSearchService::Domain", {
        ClusterConfig: Match.objectLike({
          InstanceType: "t3.small.search",
          InstanceCount: 1,
          ZoneAwarenessEnabled: false,
        }),
        EBSOptions: Match.objectLike({ VolumeSize: 10, VolumeType: "gp3" }),
      });
    }
  });

  test("the production flag makes the domain three nodes across three AZs", () => {
    const { data } = buildApp(new App(), {
      backendEnv: "production",
      awsAccountId,
      userPoolId,
      production: true,
    });
    Template.fromStack(data!).hasResourceProperties(
      "AWS::OpenSearchService::Domain",
      {
        ClusterConfig: Match.objectLike({
          InstanceType: "m7g.medium.search",
          InstanceCount: 3,
          ZoneAwarenessEnabled: true,
          ZoneAwarenessConfig: { AvailabilityZoneCount: 3 },
        }),
      },
    );
  });

  test("the domain is destroyed with the stack in every environment", () => {
    const policy = (t: Template) =>
      Object.values(t.findResources("AWS::OpenSearchService::Domain"))[0]
        .DeletionPolicy;
    expect(policy(feature.data)).toBe("Delete");
    expect(policy(dev.data)).toBe("Delete");
    expect(policy(preProduction.data)).toBe("Delete");
  });

  test.each(["archive", "collection"])(
    "the %s index template sets the generated mappings",
    (index) => {
      dev.data.hasResourceProperties("AWS::CloudFormation::CustomResource", {
        TemplateName: `dlpnext-${index}`,
        IndexPatterns: [index],
        Mappings: JSON.stringify(searchMappings(index)),
      });
    },
  );
});

describe("search mappings", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "schema", "schema.graphql"),
    "utf8",
  );
  const stored = (type: string) => {
    const body = schema.match(
      new RegExp(`^type ${type} [^{]*\\{([^}]*)\\}`, "m"),
    )![1];
    return [...body.matchAll(/^\s+(\w+): /gm)].map((m) => m[1]);
  };
  const date = {
    type: "date",
    format:
      "yyyy/MM/dd HH:mm:ss||yyyy/MM/dd||yyyy/MM||yyyy-MM-dd HH:mm:ss||yyyy-MM-dd||yyyy-MM||yyyy||M/d/yyyy||" +
      "strict_date_optional_time",
    ignore_malformed: true,
  };

  test.each([
    ["archive", "Archive", ["collection", "partner"]],
    ["collection", "Collection", ["partner"]],
  ])(
    "the %s mappings cover every stored field of %s",
    (index, type, relationships) => {
      const mapping = searchMappings(index);
      expect(mapping.dynamic).toBe(false);
      expect(Object.keys(mapping.properties)).toEqual([
        ...stored(type).filter((f) => !relationships.includes(f)),
        "date_range",
      ]);
    },
  );

  test("field types follow the schema types", () => {
    const { properties } = searchMappings("archive");
    expect(properties.title).toEqual({
      type: "text",
      fields: { keyword: { type: "keyword", ignore_above: 256 } },
    });
    expect(properties.display_date).toEqual(properties.title);
    expect(properties.visibility).toEqual({ type: "boolean" });
    expect(properties.subject).toEqual(properties.title);
  });

  test.each([
    ["archive", ["archived", "explicit", "visibility"]],
    ["collection", ["archived", "explicit_content", "visibility"]],
  ])("the Boolean fields of %s are booleans", (index, fields) => {
    const booleans = Object.entries(searchMappings(index).properties)
      .filter(([, mapping]) => mapping.type === "boolean")
      .map(([field]) => field);
    expect(booleans).toEqual(fields);
    for (const field of fields)
      expect(searchMappings(index).properties[field]).toEqual({
        type: "boolean",
      });
  });

  test("AWSJSON fields are objects with dynamically mapped subfields", () => {
    const dynamicObject = { type: "object", dynamic: true };
    const archive = searchMappings("archive");
    const collection = searchMappings("collection");
    for (const field of [
      "alt_text",
      "extracted_text",
      "manifest_file_characterization",
      "visual_description",
    ]) {
      expect(archive.properties[field]).toEqual(dynamicObject);
    }
    for (const field of ["alt_text", "collectionOptions", "ownerinfo"]) {
      expect(collection.properties[field]).toEqual(dynamicObject);
    }
    // Dynamic subfields must not be guessed to be dates
    expect(archive.date_detection).toBe(false);
    expect(collection.date_detection).toBe(false);
  });

  test("archiveOptions maps the keys the records use", () => {
    const text = searchMappings("archive").properties.title;
    expect(searchMappings("archive").properties.archiveOptions).toEqual({
      type: "object",
      properties: {
        assets: {
          type: "object",
          properties: {
            media_type: text,
            iiif_manifest: text,
            env_config: text,
            gltf_config: text,
            thumbnail: text,
            morpho_thumb: text,
            x3d_config: text,
            x3d_src_img: text,
          },
        },
        config: {
          type: "object",
          properties: {
            _3d: {
              type: "object",
              properties: {
                rotation: {
                  type: "object",
                  properties: { horizontal: text, vertical: text },
                },
                scale_factor: text,
              },
            },
          },
        },
        derivatives: {
          type: "object",
          properties: {
            downloads: {
              type: "object",
              properties: { lg: text, md: text, sm: text },
            },
          },
        },
        page_count: { type: "long" },
        audioTranscript: text,
        episodeNumber: text,
        seasonNumber: text,
        sourceLink: text,
        sourceText: text,
      },
    });
    // The legacy assets.scale_factor is not indexed; config._3d.scale_factor is
    const { assets } = searchMappings("archive").properties.archiveOptions
      .properties as Record<string, { properties: Record<string, unknown> }>;
    expect(assets.properties).not.toHaveProperty("scale_factor");
  });

  test("every date field accepts ISO 8601 and ignores malformed values", () => {
    expect(searchMappings("archive").properties).toMatchObject({
      date,
      start_date: date,
      end_date: date,
      embargo_start_date: date,
      embargo_end_date: date,
    });
    for (const index of ["archive", "collection"]) {
      const dates = Object.values(searchMappings(index).properties).filter(
        (m) => m.type === "date",
      );
      expect(dates.length).toBeGreaterThanOrEqual(4);
      for (const mapping of dates) expect(mapping).toEqual(date);
    }
  });

  test("each index has the derived date_range field, which is not a sort field", () => {
    for (const index of ["archive", "collection"]) {
      expect(searchMappings(index).properties.date_range).toEqual({
        type: "date_range",
        format: "strict_date_optional_time",
      });
      expect(numericSortFields([index])).not.toContain("date_range");
    }
  });

  test("a schema type with no mapping is an error", () => {
    expect(() =>
      buildSearchMappings(
        "type Archive { id: ID! size: Size }\nenum Size { S }",
      ),
    ).toThrow("No mapping for Archive.size: Size");
  });
});

describe("streaming Lambda", () => {
  test("runs the vendored Amplify handler on python3.12 with a 30s timeout", () => {
    dev.api.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "python_streaming_function.lambda_handler",
      Runtime: "python3.12",
      Timeout: 30,
      MemorySize: 128,
      Environment: {
        Variables: Match.objectLike({
          DEBUG: "0",
          OPENSEARCH_USE_EXTERNAL_VERSIONING: "false",
        }),
      },
    });
  });

  test("streams only Archive and Collection, with bounded retries, bisect and a failure queue", () => {
    const mappings = Object.values(
      dev.api.findResources("AWS::Lambda::EventSourceMapping"),
    );
    expect(mappings).toHaveLength(2);
    const sources = JSON.stringify(
      mappings.map((m) => m.Properties.EventSourceArn),
    );
    expect(sources).toMatch(/ArchiveTable/);
    expect(sources).toMatch(/CollectionTable/);
    expect(sources).not.toMatch(/PartnerTable/);
    for (const mapping of mappings) {
      expect(mapping.Properties).toMatchObject({
        StartingPosition: "LATEST",
        BatchSize: 100,
        MaximumBatchingWindowInSeconds: 1,
        MaximumRetryAttempts: 3,
        BisectBatchOnFunctionError: true,
      });
      expect(
        mapping.Properties.DestinationConfig.OnFailure.Destination,
      ).toBeDefined();
    }
  });
});

describe("resync Lambda", () => {
  const resyncFunction = (t: Template) =>
    Object.entries(t.findResources("AWS::Lambda::Function")).find(
      ([, f]) => f.Properties.Handler === "resync.lambda_handler",
    )!;
  /** Every statement in the policies attached to the resync function's role. */
  const resyncStatements = (t: Template) => {
    const roleRef = resyncFunction(t)[1].Properties.Role["Fn::GetAtt"][0];
    return Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) =>
        p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleRef),
      )
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
  };

  test("is named after the environment and runs the streaming code's resync entry point", () => {
    feature.api.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "dlp-access-next-f-search-opensearch-resync",
      Handler: "resync.lambda_handler",
      Runtime: "python3.12",
      Timeout: 900,
      Environment: {
        Variables: Match.objectLike({
          OPENSEARCH_USE_EXTERNAL_VERSIONING: "false",
          RESYNC_TABLES: JSON.stringify({
            Archive: "Archive-dlpnext-f-search",
            Collection: "Collection-dlpnext-f-search",
          }),
        }),
      },
    });
    feature.api.hasOutput("OpenSearchResyncFunctionName", {});
  });

  test("may read Archive and Collection items and write to the search domain, and nothing else", () => {
    const statements = resyncStatements(dev.api);
    const actions = statements.flatMap((s) => [s.Action].flat()).sort();
    expect(new Set(actions)).toEqual(
      new Set([
        "dynamodb:BatchGetItem",
        "dynamodb:Scan",
        "es:ESHttpDelete",
        "es:ESHttpGet",
        "es:ESHttpHead",
        "es:ESHttpPatch",
        "es:ESHttpPost",
        "es:ESHttpPut",
      ]),
    );
    const dynamoResources = JSON.stringify(
      statements
        .filter((s) => [s.Action].flat().includes("dynamodb:BatchGetItem"))
        .map((s) => s.Resource),
    );
    expect(dynamoResources).toMatch(/ArchiveTable/);
    expect(dynamoResources).toMatch(/CollectionTable/);
    expect(dynamoResources).not.toMatch(/PartnerTable/);
  });
});

describe("streaming failure alerts", () => {
  /** An Api stack for dev with the given alert addresses. */
  function apiWithAlertEmails(alertEmails: string[]) {
    const app = new App();
    const env = { account: awsAccountId, region: "us-east-1" };
    const config = { ...resolveEnvironment("dev"), alertEmails };
    const data = new DataStack(app, "Data", { env, config });
    const api = new ApiStack(app, "Api", {
      env,
      config,
      tables: data.tables,
      searchDomain: data.searchDomain,
    });
    return Template.fromStack(api);
  }

  const queueId = (t: Template) =>
    Object.keys(t.findResources("AWS::SQS::Queue"))[0];
  const topicId = (t: Template) =>
    Object.keys(t.findResources("AWS::SNS::Topic"))[0];

  test("every environment has an alert topic whose ARN is a stack output", () => {
    for (const t of [dev.api, preProduction.api, feature.api]) {
      t.resourceCountIs("AWS::SNS::Topic", 1);
      t.hasOutput("StreamingAlertTopicArn", {
        Value: { Ref: topicId(t) },
      });
    }
  });

  test("a message on the failure queue alarms the topic, and clearing it sends OK", () => {
    for (const t of [dev.api, feature.api]) {
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/SQS",
        MetricName: "ApproximateNumberOfMessagesVisible",
        Dimensions: [
          {
            Name: "QueueName",
            Value: { "Fn::GetAtt": [queueId(t), "QueueName"] },
          },
        ],
        Statistic: "Maximum",
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        AlarmActions: [{ Ref: topicId(t) }],
        OKActions: [{ Ref: topicId(t) }],
      });
    }
  });

  test("named environments alert the team; feature environments alert no one", () => {
    for (const t of [dev.api, preProduction.api]) {
      t.resourceCountIs("AWS::SNS::Subscription", 1);
      t.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "digitallibraries@vt.edu",
      });
    }
    feature.api.resourceCountIs("AWS::SNS::Subscription", 0);
  });

  test("each configured alert address is an email subscription on the topic", () => {
    const t = apiWithAlertEmails(["dlp-team@example.edu", "ops@example.edu"]);
    t.resourceCountIs("AWS::SNS::Subscription", 2);
    for (const address of ["dlp-team@example.edu", "ops@example.edu"]) {
      t.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: address,
        TopicArn: { Ref: topicId(t) },
      });
    }
  });
});

describe("API and Elastic Beanstalk access", () => {
  test("API is named after the environment and uses IAM auth", () => {
    dev.api.hasResourceProperties("AWS::AppSync::GraphQLApi", {
      Name: "dlp-access-next-dev",
      AuthenticationType: "AWS_IAM",
    });
  });

  test("per-environment EB instance role and profile may call the API", () => {
    dev.api.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "dlp-access-next-dev-eb",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({ Principal: { Service: "ec2.amazonaws.com" } }),
        ],
      }),
    });
    dev.api.hasResourceProperties("AWS::IAM::InstanceProfile", {
      InstanceProfileName: "dlp-access-next-dev-eb",
    });
    const ebRoleId = roleLogicalId(dev.api, "dlp-access-next-dev-eb");
    dev.api.hasResourceProperties("AWS::IAM::Policy", {
      Roles: [{ Ref: ebRoleId }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "appsync:GraphQL" }),
        ]),
      },
    });
  });

  test("per-environment Beanstalk service role, published to SSM", () => {
    const serviceRoles = Object.entries(
      dev.api.findResources("AWS::IAM::Role", {
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: [
              Match.objectLike({
                Principal: { Service: "elasticbeanstalk.amazonaws.com" },
              }),
            ],
          },
        },
      }),
    );
    expect(serviceRoles).toHaveLength(1);
    const [serviceRoleId, serviceRole] = serviceRoles[0];
    expect(serviceRole.Properties.RoleName).toBe(
      "dlp-access-next-dev-eb-service",
    );
    // Each ARN is Fn::Join ["", ["arn:", partition, ":iam::aws:policy/<name>"]].
    const managedPolicies = (
      serviceRole.Properties.ManagedPolicyArns as {
        "Fn::Join": [string, unknown[]];
      }[]
    ).map((arn) =>
      String(arn["Fn::Join"][1].at(-1)).replace(":iam::aws:policy/", ""),
    );
    expect(managedPolicies.sort()).toEqual([
      "AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy",
      "service-role/AWSElasticBeanstalkEnhancedHealth",
    ]);
    dev.api.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/dlp-access-next/dev/eb-service-role-arn",
      Value: { "Fn::GetAtt": [serviceRoleId, "Arn"] },
    });
  });

  test("instance role may read frontend client secrets named dlpnext/*, and nothing broader", () => {
    const ebRoleId = roleLogicalId(dev.api, "dlp-access-next-dev-eb");
    const readsSecrets = (s: Record<string, unknown>) =>
      [s.Action]
        .flat()
        .some((a) => a === "*" || String(a).startsWith("secretsmanager:"));
    const secretStatements = Object.values(
      dev.api.findResources("AWS::IAM::Policy"),
    ).flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as Record<string, unknown>[])
        .filter(readsSecrets)
        .map((s) => ({ roles: p.Properties.Roles, ...s })),
    );
    const roles = Object.values(dev.api.findResources("AWS::IAM::Role"));
    for (const role of roles) {
      expect(role.Properties.Policies).toBeUndefined();
    }
    expect(secretStatements).toEqual([
      {
        roles: [{ Ref: ebRoleId }],
        Effect: "Allow",
        Action: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        Resource: {
          "Fn::Join": [
            "",
            [
              "arn:",
              { Ref: "AWS::Partition" },
              `:secretsmanager:us-east-1:${awsAccountId}:secret:dlpnext/*`,
            ],
          ],
        },
      },
    ]);
  });

  test("publishes the API URL to SSM for Web stacks", () => {
    const apiId = Object.keys(
      dev.api.findResources("AWS::AppSync::GraphQLApi"),
    )[0];
    dev.api.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/dlp-access-next/dev/graphql-api-url",
      Value: { "Fn::GetAtt": [apiId, "GraphQLUrl"] },
    });
  });

  test("stack outputs what the Beanstalk config needs", () => {
    dev.api.hasOutput("GraphQLApiUrl", {});
    dev.api.hasOutput("EbInstanceProfileName", {});
    dev.api.hasOutput("EbServiceRoleArn", {});
  });
});

describe("Auth stack", () => {
  const authTemplate = (identityProvider?: string) =>
    Template.fromStack(
      buildApp(new App(), {
        backendEnv: "dev",
        awsAccountId,
        userPoolId,
        identityProvider,
      }).auth!,
    );

  test("the user pool is only recorded in SSM, not created or changed", () => {
    const auth = authTemplate();
    auth.resourceCountIs("AWS::Cognito::UserPool", 0);
    auth.resourceCountIs("AWS::Cognito::UserPoolGroup", 0);
    auth.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
    auth.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/dlp-access-next/dev/user-pool-id",
      Value: userPoolId,
    });
  });

  test("records the federated identity provider, defaulting to the pool's own users", () => {
    const parameter = (value: string) => ({
      Name: "/dlp-access-next/dev/identity-provider",
      Value: value,
    });
    authTemplate().hasResourceProperties(
      "AWS::SSM::Parameter",
      parameter("COGNITO"),
    );
    const federated = authTemplate("VT-SSO-OIDC");
    federated.hasResourceProperties(
      "AWS::SSM::Parameter",
      parameter("VT-SSO-OIDC"),
    );
    // The provider is only named: it is created outside CDK.
    federated.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });

  test.each(["VT SSO", "VT_SSO", "", "a".repeat(33)])(
    "rejects identity provider %p",
    (identityProvider) => {
      expect(() =>
        buildApp(new App(), {
          backendEnv: "dev",
          awsAccountId,
          userPoolId,
          identityProvider,
        }),
      ).toThrow(/Invalid identity-provider/);
    },
  );

  test.each([
    [
      "AbCd12345",
      /Invalid user-pool-id "AbCd12345": use a Cognito user pool ID/,
    ],
    ["us-west-2_AbCd12345", /the pool must be in us-east-1/],
  ])("rejects user pool %p", (badUserPool, message) => {
    expect(() =>
      buildApp(new App(), {
        backendEnv: "dev",
        awsAccountId,
        userPoolId: badUserPool,
      }),
    ).toThrow(message);
  });

  test("requires a user pool", () => {
    expect(() =>
      buildApp(new App(), { backendEnv: "dev", awsAccountId }),
    ).toThrow(/pass -c user-pool-id=<user pool ID>/);
  });
});
